//! 文献台账冲突的机械比对（2026-11-10 HER：精读评审撞上 included.json / to-fetch.md 冲突，用户问「怎么知道选哪一个」）。
//!
//! 两步各自跑过 `lit_records.py`，同一份台账两边都改了，Git 只会说「两边改了同一个地方」。
//! 这里按篇（id）比对 `papers/included.json` 两侧：一边已经包含另一边的全部改动时，建议选包含的那边，
//! 并用白话说清多了什么；两边各有对方没有的改动时只说明、不替人选。由它生成的几份台账跟它选同一边。
//! 只读、只建议：选边仍由人点。比不出（不是这几份、解析不了、读不到）返回 None，界面照旧只有两侧对照与 AI 建议。

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const INCLUDED: &str = "papers/included.json";
/// `lit_records.py` 从 included.json 生成的台账（references.bib 精读也会追加条目，不算纯生成，不在此列）
const DERIVED: &[&str] = &[
    "papers/included.md",
    "papers/to-fetch.md",
    "papers/to-fetch.ris",
    "papers/endnote-import.ris",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHintDto {
    /// "ours"（这一步的版本）| "theirs"（项目里的版本）| "manual"（两边各有改动，人看着选）
    pub choice: String,
    pub reason: String,
}

fn rows(text: &str) -> Option<Vec<Map<String, Value>>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let list = match parsed {
        Value::Array(list) => list,
        Value::Object(mut obj) => ["records", "items", "papers", "entries"]
            .iter()
            .find_map(|k| match obj.remove(*k) {
                Some(Value::Array(list)) => Some(list),
                _ => None,
            })?,
        _ => return None,
    };
    list.into_iter()
        .map(|row| match row {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .collect()
}

fn by_id(rows: Vec<Map<String, Value>>) -> Option<HashMap<String, Map<String, Value>>> {
    let mut out = HashMap::new();
    for row in rows {
        let id = row.get("id")?.as_str()?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        out.insert(id, row);
    }
    Some(out)
}

type Ledger = HashMap<String, Map<String, Value>>;

/// 一边相对共同祖先的改动里，另一边没有的那些，按白话归类计数
#[derive(Default)]
struct Own {
    added: usize,
    decided: usize,
    filled: usize,
}

impl Own {
    fn is_empty(&self) -> bool {
        self.added + self.decided + self.filled == 0
    }
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if self.added > 0 {
            parts.push(format!("多了 {} 篇", self.added));
        }
        if self.decided > 0 {
            parts.push(format!("{} 篇改了纳入 / 排除", self.decided));
        }
        if self.filled > 0 {
            parts.push(format!("{} 篇补了信息（如影响因子、全文位置）", self.filled));
        }
        parts.join("、")
    }
}

/// side 相对 base 改了、而 other 没有同样改动的地方（按篇计一次，判定改动优先归类）
fn own_changes(side: &Ledger, other: &Ledger, base: &Ledger) -> Own {
    let empty = Map::new();
    let mut out = Own::default();
    let mut ids: Vec<&String> = side.keys().chain(base.keys()).collect();
    ids.sort();
    ids.dedup();
    for id in ids {
        let (s, o, b) = (side.get(id), other.get(id), base.get(id));
        if s.is_none() && b.is_none() {
            continue;
        }
        if b.is_none() {
            if o != s {
                out.added += 1;
            }
            continue;
        }
        let (s, o, b) = (s.unwrap_or(&empty), o.unwrap_or(&empty), b.unwrap_or(&empty));
        let mut keys: Vec<&String> = s.keys().chain(b.keys()).collect();
        keys.sort();
        keys.dedup();
        let mine: Vec<&String> = keys
            .into_iter()
            .filter(|k| s.get(*k) != b.get(*k) && s.get(*k) != o.get(*k))
            .collect();
        if mine.is_empty() {
            continue;
        }
        if mine.iter().any(|k| k.as_str() == "decision") {
            out.decided += 1;
        } else {
            out.filled += 1;
        }
    }
    out
}

/// included.json 三方比对：ours = 这一步的版本，theirs = 项目里的版本，base = 两边分开前的共同祖先（没有时当空）
pub fn included_hint(ours: &str, theirs: &str, base: Option<&str>) -> Option<ConflictHintDto> {
    let ours = by_id(rows(ours)?)?;
    let theirs = by_id(rows(theirs)?)?;
    let base = match base {
        Some(text) => by_id(rows(text)?)?,
        None => Ledger::new(),
    };
    let mine = own_changes(&ours, &theirs, &base);
    let project = own_changes(&theirs, &ours, &base);
    if mine.is_empty() {
        let more = if project.is_empty() {
            String::new()
        } else {
            format!("，另外{}", project.describe())
        };
        return Some(ConflictHintDto {
            choice: "theirs".into(),
            reason: format!("项目里的这份已经包含这一步对清单的全部改动{more}。选它不丢东西"),
        });
    }
    if project.is_empty() {
        return Some(ConflictHintDto {
            choice: "ours".into(),
            reason: format!("这一步的这份已经包含项目里的全部改动，另外{}。选它不丢东西", mine.describe()),
        });
    }
    Some(ConflictHintDto {
        choice: "manual".into(),
        reason: format!(
            "两边各有对方没有的改动（这一步：{}；项目里：{}），选哪边都会丢掉另一边的。不确定就点「◈ AI 建议」",
            mine.describe(),
            project.describe()
        ),
    })
}

/// 冲突文件 path 的比对建议。read(stage, path) 读冲突各方全文（1 = 共同祖先，2 = 这一步，3 = 项目里）
pub fn ledger_hint(
    path: &str,
    read: impl Fn(u8, &str) -> Option<String>,
) -> Option<ConflictHintDto> {
    let path = path.replace('\\', "/");
    if path != INCLUDED && !DERIVED.contains(&path.as_str()) {
        return None;
    }
    let hint = included_hint(&read(2, INCLUDED)?, &read(3, INCLUDED)?, read(1, INCLUDED).as_deref())?;
    if path == INCLUDED || hint.choice == "manual" {
        return Some(hint);
    }
    let side = if hint.choice == "theirs" { "项目里的" } else { "这一步的" };
    Some(ConflictHintDto {
        choice: hint.choice,
        reason: format!("这份由 papers/included.json 生成，跟它选同一边（{side}版本）"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r#"[{"id":"a","title":"A","decision":"included"},{"id":"b","title":"B","decision":"included"}]"#;
    // 这一步只给 a 补了全文位置
    const OURS: &str = r#"[{"id":"a","title":"A","decision":"included","pdf":"papers/a.pdf"},{"id":"b","title":"B","decision":"included"}]"#;
    // 项目里也补了 a 的全文位置，另外 b 被移出、多了 c
    const THEIRS: &str = r#"[{"id":"a","title":"A","decision":"included","pdf":"papers/a.pdf","impactFactor":"12"},{"id":"b","title":"B","decision":"excluded"},{"id":"c","title":"C","decision":"included"}]"#;

    #[test]
    fn side_without_own_changes_defers_and_reason_counts_the_other() {
        let h = included_hint(OURS, THEIRS, Some(BASE)).unwrap();
        assert_eq!(h.choice, "theirs");
        assert!(h.reason.contains("多了 1 篇、1 篇改了纳入 / 排除、1 篇补了信息"), "{}", h.reason);
        assert_eq!(included_hint(THEIRS, OURS, Some(BASE)).unwrap().choice, "ours");
    }

    #[test]
    fn untouched_field_changed_only_upstream_is_not_counted_against_this_step() {
        // HER 实测：项目里把一篇改成排除，这一步那篇原样未动——不能算两边各改
        let ours = r#"[{"id":"k","decision":"included"}]"#;
        let theirs = r#"[{"id":"k","decision":"excluded"}]"#;
        let base = r#"[{"id":"k","decision":"included"}]"#;
        assert_eq!(included_hint(ours, theirs, Some(base)).unwrap().choice, "theirs");
    }

    #[test]
    fn both_sides_changed_is_left_to_person() {
        let ours = r#"[{"id":"a","pdf":"x.pdf"}]"#;
        let theirs = r#"[{"id":"a","impactFactor":"9"}]"#;
        let base = r#"[{"id":"a"}]"#;
        let h = included_hint(ours, theirs, Some(base)).unwrap();
        assert_eq!(h.choice, "manual");
        assert!(h.reason.contains("这一步：1 篇补了信息"), "{}", h.reason);
    }

    #[test]
    fn derived_ledger_follows_included_and_other_files_get_nothing() {
        let read = |stage: u8, p: &str| {
            assert_eq!(p, INCLUDED);
            Some(match stage { 1 => BASE, 2 => OURS, _ => THEIRS }.to_string())
        };
        let h = ledger_hint("papers/to-fetch.md", read).unwrap();
        assert_eq!(h.choice, "theirs");
        assert!(h.reason.contains("项目里的版本"));
        assert!(ledger_hint("notes/a.md", read).is_none());
        assert!(ledger_hint("references.bib", read).is_none());
        assert!(ledger_hint("papers/to-fetch.md", |_, _| Some("{坏".into())).is_none());
    }
}
