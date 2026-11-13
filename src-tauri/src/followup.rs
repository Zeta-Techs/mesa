use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FollowupPolicy {
    pub max_rounds: u32,
    pub days: u32,
    pub budget_usd: f64,
    #[serde(default)]
    pub probe: Option<String>,
}

/// 前端新建 / 更新时的严格入参（拒绝拼错字段；落盘的 FollowupPolicy 允许前向兼容未来可选字段）
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowupPolicyInput {
    pub max_rounds: u32,
    pub days: u32,
    pub budget_usd: f64,
    #[serde(default)]
    pub probe: Option<String>,
}

impl From<FollowupPolicyInput> for FollowupPolicy {
    fn from(input: FollowupPolicyInput) -> Self {
        Self {
            max_rounds: input.max_rounds,
            days: input.days,
            budget_usd: input.budget_usd,
            probe: input.probe,
        }
    }
}

impl FollowupPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if !(2..=20).contains(&self.max_rounds) || !(1..=30).contains(&self.days)
            || !self.budget_usd.is_finite() || !(0.01..=100.0).contains(&self.budget_usd) {
            return Err("跟进授权需要 2–20 轮、1–30 天和 $0.01–100 的累计预算".into());
        }
        if let Some(probe) = &self.probe {
            if probe.is_empty() || std::path::Path::new(probe).is_absolute()
                || probe.contains('\\') || probe.split('/').any(|part| matches!(part, ".." | "." | ""))
                || !probe.ends_with(".py") || probe.starts_with(".git/") || probe.starts_with(".ccode/") {
                return Err("探测脚本须是项目内相对路径的 .py 文件，不可指向 .git/.ccode".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub state: String,
    #[serde(default)]
    pub about: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

pub fn read_receipt(text: &str, now: DateTime<Utc>, deadline: DateTime<Utc>) -> Result<Receipt, String> {
    let mut opened = false;
    let mut content = String::new();
    let mut last = None;
    for line in text.lines() {
        if line.trim() == "```mesa-receipt" {
            opened = true;
            content.clear();
        } else if opened && line.trim() == "```" {
            last = Some(content.clone());
            opened = false;
        } else if opened {
            content.push_str(line);
            content.push('\n');
        }
    }
    if opened { return Err("回执代码块没有闭合".into()); }
    let receipt: Receipt = serde_json::from_str(last.as_deref().ok_or("没有 mesa-receipt 回执")?)
        .map_err(|error| format!("回执不是合法 JSON：{error}"))?;
    if !matches!(receipt.state.as_str(), "done" | "waiting" | "later")
        || receipt.about.chars().count() > 2000 {
        return Err("state 只允许 done/waiting/later，about 最多 2000 字".into());
    }
    if receipt.state != "done" && receipt.about.trim().is_empty() {
        return Err("挂起或复查必须说明剩下的工作".into());
    }
    if receipt.state == "later" {
        let key = receipt.key.as_deref().ok_or("预约需要固定 key")?;
        if key.is_empty() || key.len() > 100 || !key.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')) {
            return Err("预约 key 只能是 100 字以内的字母、数字、横线、下划线".into());
        }
        let at = DateTime::parse_from_rfc3339(receipt.at.as_deref().ok_or("预约需要带时区的 at")?)
            .map_err(|_| "预约时间必须为带时区的 RFC3339".to_string())?.with_timezone(&Utc);
        if at <= now || at > deadline { return Err("预约必须在将来且不超过授权期限".into()); }
    } else if receipt.at.is_some() || receipt.key.is_some() {
        return Err("只有 later 可带 at/key".into());
    }
    Ok(receipt)
}

pub fn prompt_note(policy: &FollowupPolicy) -> String {
    format!("\n【已授权的分轮跟进】最多 {} 轮、{} 天，累计预算 ${:.2}。只做原任务，不扩大权限，不开科研步骤、不采纳成果。需要人决定时在 .ccode/help-wanted.md 写问题并结束本轮，不用 CLI 自带提问工具等待。无需人回答的说明写报告。回答由 Mesa 交回后才继续。最后回复附：\n```mesa-receipt\n{{\"state\":\"done\"}}\n```\n未完成时 state=waiting（about 说明剩余工作，必须留人工请求）或 later（about、固定 key、带时区的 at，且在授权期内）。探测命令、权限、收件人不得写进回执。", policy.max_rounds, policy.days, policy.budget_usd)
}

pub fn repair_format(text: &str) -> Result<String, String> {
    let start = text.rfind("```mesa-receipt").ok_or("缺少回执，不能猜测业务状态")?;
    let body = text[start + "```mesa-receipt".len()..].trim();
    let body = body.split("```").next().unwrap_or(body).trim();
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| "JSON 内容损坏，不能自动猜字段")?;
    Ok(format!("```mesa-receipt\n{}\n```", serde_json::to_string(&value).map_err(|error| error.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_validates_authority_and_never_accepts_commands() {
        let now = DateTime::parse_from_rfc3339("2026-11-12T00:00:00Z").unwrap().with_timezone(&Utc);
        let deadline = now + chrono::Duration::days(7);
        let valid = "结果\n```mesa-receipt\n{\"state\":\"later\",\"about\":\"查剩下的数据\",\"key\":\"data\",\"at\":\"2026-11-13T09:00:00+08:00\"}\n```";
        assert_eq!(read_receipt(valid, now, deadline).unwrap().state, "later");
        for invalid in [valid.replace("2026-11-13", "2026-12-13"), valid.replace("2026-11-13", "2026-11-11"), valid.replace("\"state\":", "\"command\":\"rm -rf\",\"state\":"), "```mesa-receipt\n{}".into()] {
            assert!(read_receipt(&invalid, now, deadline).is_err());
        }
        assert!(read_receipt("```mesa-receipt\n{\"state\":\"waiting\",\"about\":\"等人决定\"}\n```", now, deadline).is_ok());
        let fixed = repair_format("结果\n```mesa-receipt\n{\"state\":\"done\"}").unwrap();
        assert_eq!(read_receipt(&fixed, now, deadline).unwrap().state, "done");
        assert!(repair_format("执行失败，请帮我猜结果").is_err());
    }

    #[test]
    fn probe_cannot_escape_project_and_policy_requires_limits() {
        let mut policy = FollowupPolicy { max_rounds: 4, days: 7, budget_usd: 2.0, probe: Some("scripts/probe.py".into()) };
        assert!(policy.validate().is_ok());
        for path in ["../probe.py", "/tmp/probe.py", "a/../probe.py", ".ccode/probe.py", "scripts/probe.py;echo x"] {
            policy.probe = Some(path.into()); assert!(policy.validate().is_err());
        }
        policy.probe = None; policy.budget_usd = f64::NAN;
        assert!(policy.validate().is_err());
        // 落盘配置允许未来版本新增可选字段，编辑入参仍严格拦截拼写错误
        let persisted: FollowupPolicy = serde_json::from_str(r#"{"maxRounds":4,"days":7,"budgetUsd":2.0,"futureOptional":true}"#).unwrap();
        assert_eq!(persisted.max_rounds, 4);
        assert!(serde_json::from_str::<FollowupPolicyInput>(r#"{"maxRounds":4,"days":7,"budgetUsd":2.0,"typo":1}"#).is_err());
    }
}
