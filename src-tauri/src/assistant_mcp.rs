//! 项目助手专属本地只读 + 提议 MCP Server（`mesa_helper assistant-mcp --project <root> --proposals <file>`）。
//!
//! 职责边界：
//! - 零外部依赖、零网络监听、不触密钥，纯 Rust stdio JSON-RPC 2.0（兼容 MCP 2024-11-05 / 2025-03-26）；
//! - 8 个只读工具直连 `assistant_state` 与内置说明书；
//! - 4 个提议工具仅把通过严格 schema 与路径校验的结构化提议写入本轮 0600 临时 `proposals.json`，
//!   绝不修改项目文件、`app.db`、`project.toml` 或 `memory.md`——由用户点击确认卡后才经 Mesa 原入口执行。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use crate::assistant_state;
use crate::project_assistant::{guide_search, guide_section, missing_paths_sync};
use crate::sessions::expand_tilde;

const ALLOWED_ACTIONS: &[&str] = &[
    "step", "review", "project", "agents", "profiles", "settings", "schedule", "mail", "split",
    "discuss", "consult", "report",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedWorkOrderDto {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    pub title: String,
    pub task: String,
    #[serde(default)]
    pub done: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assumptions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub must_ask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedReworkOrderDto {
    pub to_step: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_step: Option<u32>,
    pub topics: Vec<String>,
    pub reason: String,
    #[serde(default)]
    pub clues: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedMemoryDto {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedActionDto {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantProposalsDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_order: Option<ProposedWorkOrderDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rework_order: Option<ProposedReworkOrderDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memories: Vec<ProposedMemoryDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<ProposedActionDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guide_headings: Vec<String>,
}

impl AssistantProposalsDto {
    pub(crate) fn is_empty(&self) -> bool {
        self.work_order.is_none()
            && self.rework_order.is_none()
            && self.memories.is_empty()
            && self.actions.is_empty()
            && self.guide_headings.is_empty()
    }
}

pub(crate) struct McpSession {
    project_root: String,
    proposals_path: Option<PathBuf>,
    proposals: AssistantProposalsDto,
}

impl McpSession {
    pub(crate) fn new(project_root: String, proposals_path: Option<PathBuf>) -> Self {
        let existing = proposals_path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<AssistantProposalsDto>(&s).ok())
            .unwrap_or_default();
        Self {
            project_root: expand_tilde(project_root.trim()),
            proposals_path,
            proposals: existing,
        }
    }

    fn flush_proposals(&self) -> Result<(), String> {
        let Some(ref path) = self.proposals_path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&self.proposals).map_err(|e| e.to_string())?;
        crate::storage::atomic_write(path, &bytes, true)
    }

    pub(crate) fn handle_message(&mut self, msg: &Value) -> Option<Value> {
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let id = msg.get("id").cloned();
        // JSON-RPC 通知没有 id，不能回包
        if id.is_none() || method.starts_with("notifications/") {
            return None;
        }
        let id = id.unwrap();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => {
                let proto = params
                    .get("protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("2024-11-05");
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": proto,
                        "capabilities": { "tools": {} },
                        "serverInfo": {
                            "name": "mesa-assistant",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }
                }))
            }
            "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            "tools/list" => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": tool_definitions() }
            })),
            "tools/call" => {
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let (text, is_error) = match self.call_tool(name, &args) {
                    Ok(v) => (v, false),
                    Err(e) => (format!("错误：{e}"), true),
                };
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": text }],
                        "isError": is_error
                    }
                }))
            }
            _ => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("未知方法：{method}") }
            })),
        }
    }

    fn call_tool(&mut self, name: &str, args: &Value) -> Result<String, String> {
        match name {
            "project_overview" => {
                let ov = assistant_state::project_overview(&self.project_root)?;
                serde_json::to_string_pretty(&ov).map_err(|e| e.to_string())
            }
            "step_detail" => {
                let step = args
                    .get("step")
                    .and_then(|v| v.as_u64())
                    .ok_or("缺少 step 参数（从 1 开始的步骤编号）")? as u32;
                let detail = assistant_state::step_detail(&self.project_root, step)?;
                serde_json::to_string_pretty(&detail).map_err(|e| e.to_string())
            }
            "list_files" => {
                let prefix = args.get("prefix").and_then(|v| v.as_str());
                let query = args.get("query").and_then(|v| v.as_str());
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(60) as usize;
                let res = assistant_state::list_files(&self.project_root, prefix, query, limit)?;
                serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
            }
            "recent_errors" => {
                let days = args.get("days").and_then(|v| v.as_i64()).unwrap_or(3);
                let res = assistant_state::recent_errors(&self.project_root, days)?;
                serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
            }
            "project_knowledge" => {
                let res = assistant_state::project_knowledge(&self.project_root)?;
                serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
            }
            "recent_consults" => {
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(3) as usize;
                let res = assistant_state::recent_consults(&self.project_root, limit)?;
                serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
            }
            "search_guide" => {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or("缺少 query 参数")?;
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(3).clamp(1, 5) as usize;
                let hits = guide_search(query, limit);
                for h in &hits {
                    if !self.proposals.guide_headings.contains(&h.heading) {
                        self.proposals.guide_headings.push(h.heading.clone());
                    }
                }
                let _ = self.flush_proposals();
                serde_json::to_string_pretty(&hits).map_err(|e| e.to_string())
            }
            "read_guide" => {
                let heading = args
                    .get("heading")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or("缺少 heading 参数")?;
                let text = guide_section(heading).ok_or_else(|| format!("未找到说明书小节「{heading}」"))?;
                if !self.proposals.guide_headings.iter().any(|h| h == heading) {
                    self.proposals.guide_headings.push(heading.to_string());
                    let _ = self.flush_proposals();
                }
                Ok(text)
            }
            "propose_work_order" => self.handle_propose_work_order(args),
            "propose_rework" => self.handle_propose_rework(args),
            "propose_memory" => self.handle_propose_memory(args),
            "suggest_actions" => self.handle_suggest_actions(args),
            other => Err(format!("未知工具：{other}")),
        }
    }

    fn step_count_and_mode(&self) -> (u32, String) {
        let cfg = crate::projects::read_config_at(Path::new(&self.project_root)).config;
        let mode = crate::workspaces::db()
            .ok()
            .and_then(|c| crate::projects::list_projects_in(&c).ok())
            .and_then(|list| list.into_iter().find(|p| crate::paths::same_path(&p.path, &self.project_root)))
            .map(|p| p.work_mode)
            .unwrap_or_else(|| "research".into());
        (cfg.steps.len() as u32, mode)
    }

    fn handle_propose_work_order(&mut self, args: &Value) -> Result<String, String> {
        let (step_count, work_mode) = self.step_count_and_mode();
        let target = args
            .get("target")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if target != "step" && target != "goal" {
            return Err("target 必须是 \"step\" 或 \"goal\"".into());
        }
        if target == "goal" && work_mode == "coding" {
            return Err("编程项目按分支开工、不走新目标；请直接给方案并调用 suggest_actions([{\"kind\":\"project\"}]) 引导去项目页开分支".into());
        }
        let step = args.get("step").and_then(|v| v.as_u64()).map(|n| n as u32);
        if target == "step" {
            let n = step.ok_or("target=\"step\" 时必须提供 step（从 1 开始）")?;
            if n < 1 || n > step_count {
                return Err(format!("步骤编号 {n} 超出范围（当前项目共 {step_count} 步）"));
            }
        }
        let task = req_str(args, "task", 4000)?;
        let title = opt_str(args, "title", 80).unwrap_or_else(|| {
            task.lines().next().unwrap_or(&task).chars().take(40).collect()
        });
        let done = opt_str(args, "done", 2000).unwrap_or_default();
        let raw_inputs = str_vec(args, "inputs", 30);
        let inputs: Vec<String> = raw_inputs
            .into_iter()
            .filter_map(|p| sanitize_rel_path(&p))
            .collect();
        let missing = if !inputs.is_empty() && Path::new(&self.project_root).is_dir() {
            missing_paths_sync(&self.project_root, inputs.clone())
        } else {
            Vec::new()
        };
        let skills = str_vec(args, "skills", 8);
        let order = ProposedWorkOrderDto {
            target: target.to_string(),
            step: if target == "step" { step } else { None },
            title,
            task,
            done,
            inputs: (!inputs.is_empty()).then_some(inputs),
            deliver: opt_str(args, "deliver", 2000),
            based_on: opt_str(args, "basedOn", 80).or_else(|| opt_str(args, "based_on", 80)),
            skills: (!skills.is_empty()).then_some(skills),
            assumptions: opt_str(args, "assumptions", 2000),
            must_ask: opt_str(args, "mustAsk", 2000).or_else(|| opt_str(args, "must_ask", 2000)),
            schedule: opt_str(args, "schedule", 80),
        };
        self.proposals.work_order = Some(order);
        self.proposals.rework_order = None;
        self.flush_proposals()?;
        let mut msg = "已生成待用户确认的派活单卡片（尚未派出，用户点击「派出去」后才会开工；回答中严禁声称已派出或已启动）。".to_string();
        if !missing.is_empty() {
            msg.push_str(&format!("注意：以下依据材料路径在项目下未找到：{}，请在回答中提醒核对。", missing.join("、")));
        }
        Ok(msg)
    }

    fn handle_propose_rework(&mut self, args: &Value) -> Result<String, String> {
        let (step_count, _) = self.step_count_and_mode();
        let to_step = args
            .get("toStep")
            .or_else(|| args.get("to_step"))
            .and_then(|v| v.as_u64())
            .ok_or("缺少 toStep（退回到第几步）")? as u32;
        if to_step < 1 || to_step > step_count {
            return Err(format!("toStep={to_step} 超出范围（共 {step_count} 步）"));
        }
        let from_step = args
            .get("fromStep")
            .or_else(|| args.get("from_step"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        if let Some(f) = from_step {
            if f <= to_step || f > step_count {
                return Err(format!("fromStep={f} 必须大于 toStep={to_step} 且不超过 {step_count}"));
            }
        }
        let topics = str_vec(args, "topics", 12);
        if topics.is_empty() {
            return Err("topics 不能为空（至少列出 1 条要补/要改的主题）".into());
        }
        let reason = req_str(args, "reason", 1000)?;
        let rework = ProposedReworkOrderDto {
            to_step,
            from_step,
            topics,
            reason,
            clues: opt_str(args, "clues", 1000).unwrap_or_default(),
            scale: args.get("scale").and_then(|v| v.as_u64()).map(|n| n.min(500) as u32),
        };
        self.proposals.rework_order = Some(rework);
        self.proposals.work_order = None;
        self.flush_proposals()?;
        Ok("已生成待用户确认的补料单卡片（尚未发出，用户核对并点击「退回去补」后才执行）。".into())
    }

    fn handle_propose_memory(&mut self, args: &Value) -> Result<String, String> {
        let arr = args
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or("缺少 items 数组")?;
        let existing: Vec<String> = crate::project_memory::read_at(Path::new(&self.project_root))
            .map(|d| {
                d.entries
                    .into_iter()
                    .filter(|e| e.meta.state == "active")
                    .map(|e| e.text.trim().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let mut added = 0usize;
        for item in arr {
            if self.proposals.memories.len() >= 5 {
                break;
            }
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(text) = text else {
                continue;
            };
            let clipped: String = text.chars().take(300).collect();
            if existing.iter().any(|e| e == &clipped)
                || self.proposals.memories.iter().any(|m| m.text == clipped)
            {
                continue;
            }
            let source = item
                .get("source")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(120).collect());
            self.proposals.memories.push(ProposedMemoryDto { text: clipped, source });
            added += 1;
        }
        self.flush_proposals()?;
        Ok(format!("已起草 {added} 条待用户确认的项目知识卡（用户逐条点击「记进项目知识」才会写入）。"))
    }

    fn handle_suggest_actions(&mut self, args: &Value) -> Result<String, String> {
        let (step_count, _) = self.step_count_and_mode();
        let arr = args
            .get("actions")
            .and_then(|v| v.as_array())
            .ok_or("缺少 actions 数组")?;
        let mut out = Vec::new();
        for item in arr {
            if out.len() >= 3 {
                break;
            }
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("").trim();
            if !ALLOWED_ACTIONS.contains(&kind) {
                continue;
            }
            let step = item.get("step").and_then(|v| v.as_u64()).map(|n| n as u32);
            if matches!(kind, "step" | "review" | "mail") {
                let Some(n) = step else { continue };
                if n < 1 || n > step_count {
                    continue;
                }
            }
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .chars()
                .take(400)
                .collect::<String>();
            if matches!(kind, "mail" | "split" | "discuss" | "consult" | "report") && text.is_empty() {
                continue;
            }
            let label = item
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .chars()
                .take(40)
                .collect::<String>();
            let dup = out
                .iter()
                .any(|a: &ProposedActionDto| a.kind == kind && a.step == step);
            if !dup {
                out.push(ProposedActionDto {
                    kind: kind.to_string(),
                    step: matches!(kind, "step" | "review" | "mail").then_some(step).flatten(),
                    text,
                    label,
                });
            }
        }
        self.proposals.actions = out;
        self.flush_proposals()?;
        Ok(format!("已挂载 {} 个跳转按钮。", self.proposals.actions.len()))
    }
}

fn req_str(args: &Value, key: &str, max_chars: usize) -> Result<String, String> {
    opt_str(args, key, max_chars).ok_or_else(|| format!("缺少必填字段 {key}"))
}

fn opt_str(args: &Value, key: &str, max_chars: usize) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(max_chars).collect())
}

fn str_vec(args: &Value, key: &str, cap: usize) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = args.get(key).and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                let s = s.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
                if out.len() >= cap {
                    break;
                }
            }
        }
    }
    out
}

pub(crate) fn sanitize_rel_path(raw: &str) -> Option<String> {
    let p = raw
        .trim()
        .trim_matches('`')
        .trim_start_matches("./")
        .replace('\\', "/");
    if p.is_empty() || p.starts_with('/') || p.starts_with('~') {
        return None;
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    if p.split('/').any(|seg| seg == "..") {
        return None;
    }
    Some(p)
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "project_overview",
            "description": "获取当前 Mesa 项目的权威总览：总进度、全部流程步骤状态（含已归档收起）、流程外目标（仅用户显式声明的目标）、完结产物与目标期刊、待回答人工请求、定时任务、近期派活、已装技能与内置科研任务。回答任何关于项目进度或现状的问题前先调用。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "step_detail",
            "description": "查询指定第 N 步（从 1 开始）的详细信息：任务简报、应交产物、验收标准、核验清单（拦下/待判断）、评审退回意见、人工事项清单、未处理后续建议与近期运行记录。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "step": { "type": "integer", "description": "步骤编号，从 1 开始" }
                },
                "required": ["step"]
            }
        },
        {
            "name": "list_files",
            "description": "列出项目文件夹中的文件清单（按最近修改时间排序），支持目录前缀与关键词筛选。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prefix": { "type": "string", "description": "可选目录前缀，如 output/ 或 manuscript/" },
                    "query": { "type": "string", "description": "可选路径关键词（忽略大小写）" },
                    "limit": { "type": "integer", "description": "返回条数上限（默认 60，最大 200）" }
                }
            }
        },
        {
            "name": "recent_errors",
            "description": "查询项目近期未解决的运行失败与 Mesa 后台报错（默认近 3 天，自动排除已保存步骤的历史失败与已归档副本的正常目录提示）。仅在排查出错或异常时调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "days": { "type": "integer", "description": "回溯天数（1-30，默认 3）" }
                }
            }
        },
        {
            "name": "project_knowledge",
            "description": "读取当前项目的长期知识（已定 / 不做）与用户跨项目研究档案。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "recent_consults",
            "description": "读取项目最近的多模型研讨记录摘要。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "条数上限（1-5，默认 3）" }
                }
            }
        },
        {
            "name": "search_guide",
            "description": "检索 Mesa 随包离线用户说明书，回答「Mesa 怎么用 / 某设置在哪 / 某功能什么意思」时调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "检索关键词或问题" },
                    "limit": { "type": "integer", "description": "返回段数（1-5，默认 3）" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "read_guide",
            "description": "按小节标题读取 Mesa 离线说明书原文。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "heading": { "type": "string", "description": "说明书小节标题" }
                },
                "required": ["heading"]
            }
        },
        {
            "name": "propose_work_order",
            "description": "起草一张待用户点击确认的派活单卡片（交给第 N 步的 AI 或另起新目标）。你不能直接修改项目文件，真要动手干活时必须调用此工具；调用后只生成确认卡，尚未派出。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "enum": ["step", "goal"], "description": "交给第 N 步(step) 或 另起新目标(goal)" },
                    "step": { "type": "integer", "description": "target=step 时的步骤编号（从 1 开始）" },
                    "title": { "type": "string", "description": "十来个字的简短标题" },
                    "task": { "type": "string", "description": "具体要做什么，写清依据文件与位置" },
                    "inputs": { "type": "array", "items": { "type": "string" }, "description": "依据材料（项目根相对路径列表，可省）" },
                    "deliver": { "type": "string", "description": "交付物及路径（可省）" },
                    "done": { "type": "string", "description": "怎样算做完的可核对标准" },
                    "basedOn": { "type": "string", "description": "按哪个内置任务或我的任务做法（可省）" },
                    "skills": { "type": "array", "items": { "type": "string" }, "description": "点名用到的已装技能名（可省）" },
                    "assumptions": { "type": "string", "description": "先定下的默认假设（可省）" },
                    "mustAsk": { "type": "string", "description": "遇到哪些情况必须停下来问用户（可省）" },
                    "schedule": { "type": "string", "description": "如用户想定期执行，写周期说明如「每周五 17:00」（可省）" }
                },
                "required": ["target", "title", "task"]
            }
        },
        {
            "name": "propose_rework",
            "description": "当需要按后续步骤的新结论回头补文献、补精读或改前面步骤产物时，起草一张补料单/修改单卡片待用户确认。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "toStep": { "type": "integer", "description": "要退回到第几步（从 1 开始）" },
                    "fromStep": { "type": "integer", "description": "因哪一步结论回头（可选，须大于 toStep）" },
                    "topics": { "type": "array", "items": { "type": "string" }, "description": "要补或要改的主题条目列表" },
                    "reason": { "type": "string", "description": "退回原因与依据" },
                    "clues": { "type": "string", "description": "关键词或参考线索（可省）" },
                    "scale": { "type": "integer", "description": "大致补多少篇（可省）" }
                },
                "required": ["toStep", "topics", "reason"]
            }
        },
        {
            "name": "propose_memory",
            "description": "当用户说出以后都要长期遵守的偏好/规矩时，起草待用户确认的「以后照这样办」项目知识卡片（最多 5 条）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": { "type": "string", "description": "简明可执行的长期约定" },
                                "source": { "type": "string", "description": "依据来源（可省）" }
                            },
                            "required": ["text"]
                        }
                    }
                },
                "required": ["items"]
            }
        },
        {
            "name": "suggest_actions",
            "description": "在回答底部挂载最多 3 个 Mesa 页面跳转按钮（仅白名单动作）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["step", "review", "project", "agents", "profiles", "settings", "schedule", "mail", "split", "discuss", "consult", "report"] },
                                "step": { "type": "integer", "description": "kind 为 step/review/mail 时的步骤号" },
                                "text": { "type": "string", "description": "附加参数（如 goal:<id>、留话内容、拆分内容、商量问题、报告说明）" },
                                "label": { "type": "string", "description": "可选按钮文案" }
                            },
                            "required": ["kind"]
                        }
                    }
                },
                "required": ["actions"]
            }
        }
    ])
}

/// `mesa_helper assistant-mcp --project <path> [--proposals <file>]` 入口
pub(crate) fn helper_mcp_cli(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--probe") {
        println!("ok");
        return 0;
    }
    let mut project_root: Option<String> = None;
    let mut proposals_path: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--project" => {
                project_root = args.get(i + 1).cloned();
                i += 2;
            }
            "--proposals" => {
                proposals_path = args.get(i + 1).map(PathBuf::from);
                i += 2;
            }
            _ => i += 1,
        }
    }
    let Some(root) = project_root else {
        eprintln!("缺少 --project 参数");
        return 2;
    };
    let mut session = McpSession::new(root, proposals_path);
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let err = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("JSON 解析失败：{e}") }
                });
                let _ = writeln!(stdout, "{err}");
                let _ = stdout.flush();
                continue;
            }
        };
        if let Some(reply) = session.handle_message(&msg) {
            if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_handshake_tools_list_and_guide_search_records_heading() {
        let tmp = std::env::temp_dir().join(format!("mesa-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let props = tmp.join("proposals.json");
        let mut sess = McpSession::new(tmp.to_string_lossy().into_owned(), Some(props.clone()));

        let init = sess
            .handle_message(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-03-26" }
            }))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(sess.handle_message(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());

        let list = sess
            .handle_message(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 12);

        let search = sess
            .handle_message(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "search_guide", "arguments": { "query": "怎么换模型" } }
            }))
            .unwrap();
        assert_eq!(search["result"]["isError"], false);
        let saved: AssistantProposalsDto =
            serde_json::from_str(&std::fs::read_to_string(&props).unwrap()).unwrap();
        assert!(!saved.guide_headings.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn mcp_propose_work_order_sanitizes_paths_and_persists_proposals() {
        let tmp = std::env::temp_dir().join(format!("mesa-mcp-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("output")).unwrap();
        std::fs::write(tmp.join("output/review.pdf"), "pdf").unwrap();
        let props = tmp.join("proposals.json");
        let mut sess = McpSession::new(tmp.to_string_lossy().into_owned(), Some(props.clone()));

        let res = sess
            .handle_message(&json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {
                    "name": "propose_work_order",
                    "arguments": {
                        "target": "goal",
                        "title": "起草审稿回复",
                        "task": "根据审稿意见逐条起草回复信",
                        "inputs": ["output/review.pdf", "/etc/passwd", "../secret.txt", "output/missing.md"],
                        "basedOn": "审稿意见回复",
                        "skills": ["rebuttal-crafter"]
                    }
                }
            }))
            .unwrap();
        assert_eq!(res["result"]["isError"], false);
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("output/missing.md"), "缺失路径应在工具回执中提示");

        let saved: AssistantProposalsDto =
            serde_json::from_str(&std::fs::read_to_string(&props).unwrap()).unwrap();
        let order = saved.work_order.expect("应落盘派活单提议");
        assert_eq!(order.target, "goal");
        assert_eq!(order.title, "起草审稿回复");
        assert_eq!(
            order.inputs.unwrap(),
            vec!["output/review.pdf".to_string(), "output/missing.md".to_string()],
            "绝对路径与越界 .. 必须被剥除"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
