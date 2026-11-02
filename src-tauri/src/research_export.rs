//! 研究记录的查看与三个导出（2026-11-02，`docs/design-research-moat.md` §3.2）。
//!
//! - AI 使用声明草稿：按 `.ccode/record.jsonl` 统计用过的 AI 工具、模型与用途，拼成中英两段草稿；
//! - 复现包：脚本、登记文件、引文库、档案卡、研究记录与核验存档打成 zip，数据只记哈希不带本体；
//! - 过程报告：给导师 / 学位办 / 伦理审查看的 HTML——运行时间线、人的决定、核验摘要、人机分工。
//!
//! 全部只读项目、写到「下载/ccode-exports/」；出站前整份过 `redact_sensitive_text`。
//! 不含对话原文；这是透明说明，不做「降 AI 率」。
use crate::research_record::{read_records_at, render_ai_usage, CheckItem, RunRecord};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const CODE_FILE_CAP: u64 = 5 * 1024 * 1024;
const PACK_TOTAL_CAP: u64 = 200 * 1024 * 1024;
const HASH_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const SKIP_DIRS: [&str; 6] = [".git", "node_modules", "__pycache__", ".venv", "venv", ".quarto"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRecordDto {
    pub runs: Vec<RunRecord>,
}

#[tauri::command]
pub async fn research_record_read(path: String) -> Result<ResearchRecordDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err("项目文件夹不存在".to_string());
        }
        let mut runs = read_records_at(&root);
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(ResearchRecordDto { runs })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn purpose_short(purpose: &str) -> &str {
    purpose.strip_prefix("研究流程：").unwrap_or(purpose)
}

fn agent_label(agent: &str) -> String {
    crate::agent_specs::agent_spec(agent)
        .map(|s| s.display_name.to_string())
        .unwrap_or_else(|| agent.to_string())
}

/// 「Claude Code（claude-opus-4、claude-sonnet-4）」这样的工具清单，按首次使用排；english = 半角标点（英文声明用）
fn tools_list(records: &[RunRecord], english: bool) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut models: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut sorted: Vec<&RunRecord> = records.iter().collect();
    sorted.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    for r in sorted {
        let label = agent_label(&r.agent);
        if !order.contains(&label) {
            order.push(label.clone());
        }
        let list = models.entry(label).or_default();
        for m in &r.models {
            if !list.contains(m) {
                list.push(m.clone());
            }
        }
    }
    order
        .into_iter()
        .map(|label| {
            let ms = &models[&label];
            if ms.is_empty() {
                label
            } else if english {
                format!("{label} ({})", ms.join(", "))
            } else {
                format!("{label}（{}）", ms.join("、"))
            }
        })
        .collect()
}

fn purposes_list(records: &[RunRecord]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut sorted: Vec<&RunRecord> = records.iter().collect();
    sorted.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    for r in sorted {
        let p = purpose_short(&r.purpose).to_string();
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

pub(crate) fn render_ai_statement(project: &str, records: &[RunRecord]) -> String {
    let mut text = format!(
        "# AI 使用声明草稿（{project}）\n\n\
         > 草稿由 Mesa 按本项目的研究记录统计生成，只含在 Mesa 里运行过的 AI。用途措辞、是否补充 Mesa 之外用过的工具、\n\
         > 期刊要求的格式，以作者核对为准。这是透明说明，不用于、也不能用于规避 AI 生成内容检测。\n\n"
    );
    if records.is_empty() {
        text.push_str("本项目还没有 AI 运行记录。\n");
        return text;
    }
    let tools = tools_list(records, false).join("；");
    let tools_en = tools_list(records, true).join("; ");
    let purposes = purposes_list(records).join("、");
    let purposes_en = purposes_list(records).join("; ");
    text.push_str(&format!(
        "## 中文\n\n在本研究与稿件的准备过程中，作者使用了 {tools}，用于{purposes}。\
         使用后，作者对相关内容逐项审阅、核对与修改，并对发表内容承担全部责任。\n\n\
         ## English\n\nDuring the preparation of this work, the author(s) used {tools_en} for: {purposes_en} \
         [translate the purposes]. After using these tools, the author(s) reviewed and edited the content as needed \
         and take(s) full responsibility for the content of the publication.\n\n\
         ## 依据（Mesa 统计）\n\n"
    ));
    let usage = render_ai_usage(records);
    text.push_str(usage.split_once("\n| ").map(|(_, t)| t).map(|t| format!("| {t}")).as_deref().unwrap_or(&usage));
    text
}

fn exports_dir() -> Result<PathBuf, String> {
    let dir = crate::diagnostics::bundle_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    Ok(dir)
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".into())
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn redact(text: &str) -> String {
    crate::sessions::redact_sensitive_text(text)
}

// ---------------- 复现包 ----------------

fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(root, &path, out);
            }
        } else if meta.is_file() {
            out.push(path);
        }
    }
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

const CODE_EXT: [&str; 12] = ["py", "r", "jl", "m", "do", "sas", "ipynb", "qmd", "rmd", "sh", "ps1", "sql"];
const ENV_FILES: [&str; 9] = [
    "requirements.txt",
    "environment.yml",
    "environment.yaml",
    "pyproject.toml",
    "uv.lock",
    "renv.lock",
    "Project.toml",
    "Manifest.toml",
    "DESCRIPTION",
];
const KEEP_FILES: [&str; 9] = [
    "references.bib",
    "artifacts.yaml",
    "manuscript/numbers.json",
    "manuscript/evidence.json",
    "figures/manifest.json",
    ".ccode/project.toml",
    ".ccode/record.jsonl",
    ".ccode/ai-usage.md",
    "README.md",
];
const DATA_DIRS: [&str; 5] = ["data/", "results/", "output/", "analysis/", "artifacts/"];

/// 哪些文件进复现包：代码与环境文件、登记文件、研究记录与核验存档。数据目录只记哈希
fn pack_selection(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut all = Vec::new();
    walk(root, root, &mut all);
    let mut include = Vec::new();
    let mut data = Vec::new();
    for path in all {
        let r = rel(root, &path);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let base = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let code = CODE_EXT.contains(&ext.as_str()) && !r.starts_with("papers/");
        let keep = KEEP_FILES.contains(&r.as_str())
            || ENV_FILES.contains(&base.as_str())
            || r.starts_with(".ccode/checks/runs/")
            || r.starts_with(".ccode/record/tasks/");
        if code || keep {
            include.push(r);
        } else if DATA_DIRS.iter().any(|d| r.starts_with(d)) {
            data.push(r);
        }
    }
    (include, data)
}

fn sha256_capped(path: &Path, budget: &mut u64) -> Option<String> {
    use sha2::{Digest, Sha256};
    let size = fs::metadata(path).ok()?.len();
    if size > *budget {
        return None;
    }
    *budget -= size;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

pub(crate) fn write_repro_pack(root: &Path, out: &Path) -> Result<(usize, usize), String> {
    let (include, data) = pack_selection(root);
    let tmp = out.with_extension("zip.tmp");
    let file = fs::File::create(&tmp).map_err(|e| format!("创建复现包失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    let mut total = 0u64;
    let mut packed = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    for r in &include {
        let path = root.join(r);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > CODE_FILE_CAP || total + size > PACK_TOTAL_CAP {
            skipped.push(r.clone());
            continue;
        }
        let bytes = fs::read(&path).map_err(|e| format!("读取 {r} 失败: {e}"))?;
        // 文本文件出包前脱敏（脚本里偶尔写着密钥）；二进制原样
        let bytes = match String::from_utf8(bytes) {
            Ok(text) => redact(&text).into_bytes(),
            Err(e) => e.into_bytes(),
        };
        writer.start_file(r.as_str(), opts).map_err(|e| format!("写入复现包失败: {e}"))?;
        writer.write_all(&bytes).map_err(|e| format!("写入复现包失败: {e}"))?;
        total += size;
        packed += 1;
    }
    let mut budget = HASH_BUDGET;
    let mut manifest = format!(
        "# 复现包清单（{}，{}）\n\n由 Mesa 导出。包含代码、环境文件、登记文件（数字 / 摘录 / 图）、引文库、项目档案卡、\
         研究记录与核验存档；**数据本体不在包里**，下表记哈希，复现时把同样的数据放回原位置后核对。\n\n",
        project_name(root),
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    );
    manifest.push_str("## 数据文件\n\n| 文件 | 大小（字节） | SHA-256 |\n|---|---:|---|\n");
    for r in &data {
        let path = root.join(r);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let hash = sha256_capped(&path, &mut budget).unwrap_or_else(|| "（超出哈希预算，只记大小）".into());
        manifest.push_str(&format!("| `{}` | {} | {} |\n", r.replace('|', "\\|"), size, hash));
    }
    if data.is_empty() {
        manifest.push_str("| （没有 data/ results/ output/ analysis/ artifacts/ 下的文件） | | |\n");
    }
    if !skipped.is_empty() {
        manifest.push_str("\n## 太大没打进包的文件\n\n");
        for r in &skipped {
            manifest.push_str(&format!("- `{r}`\n"));
        }
    }
    writer
        .start_file("MANIFEST.md", opts)
        .map_err(|e| format!("写入复现包失败: {e}"))?;
    writer
        .write_all(redact(&manifest).as_bytes())
        .map_err(|e| format!("写入复现包失败: {e}"))?;
    writer.finish().map_err(|e| format!("写入复现包失败: {e}"))?;
    fs::rename(&tmp, out).map_err(|e| format!("保存复现包失败: {e}"))?;
    Ok((packed, data.len()))
}

// ---------------- 过程报告 ----------------

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn read_archived_checks(root: &Path) -> BTreeMap<String, Vec<CheckItem>> {
    let mut out = BTreeMap::new();
    let dir = root.join(".ccode").join("checks").join("runs");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(run_id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let items: Vec<CheckItem> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l.trim()).ok())
            .collect();
        out.insert(run_id.to_string(), items);
    }
    out
}

/// 人在逐条裁决 / 审查报告里定下的条数（「裁决：」「决定：」后面写了实际结论的行）
fn human_decisions(root: &Path) -> (usize, usize) {
    let mut verdicts = 0;
    let mut decisions = 0;
    let mut files = Vec::new();
    for dir in ["manuscript", "submission", "rebuttal"] {
        walk(root, &root.join(dir), &mut files);
    }
    for path in files {
        let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !name.ends_with(".md") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if name.starts_with("verification-decisions") {
            verdicts += text
                .lines()
                .filter(|l| {
                    l.split("裁决：")
                        .nth(1)
                        .map(|v| {
                            let v = v.split('|').next().unwrap_or("").trim();
                            !v.is_empty() && v != "待裁决"
                        })
                        .unwrap_or(false)
                })
                .count();
        } else if name.starts_with("review-report") {
            decisions += text
                .lines()
                .filter(|l| {
                    let t = l.trim_start_matches(['-', ' ', '*']);
                    t.starts_with("决定：接受") || t.starts_with("决定：拒绝") || t.starts_with("决定：修改")
                })
                .count();
        }
    }
    (verdicts, decisions)
}

const DETAIL_CAP: usize = 200 * 1024;

fn capped(text: &str) -> String {
    if text.len() <= DETAIL_CAP {
        return text.to_string();
    }
    let mut cut = DETAIL_CAP;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…（超长截断）", &text[..cut])
}

/// details = 附任务书原文与对话原文（都已脱敏；默认不附）
pub(crate) fn render_process_report(root: &Path, details: bool) -> String {
    let project = project_name(root);
    let mut runs = read_records_at(root);
    runs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let accepts = crate::projects::read_acceptance_log_at(root);
    let checks = read_archived_checks(root);
    let (verdicts, decisions) = human_decisions(root);
    let mut html = format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>研究过程报告 · {p}</title>\
         <style>body{{font:14px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#222}}\
         h1{{font-size:22px}}h2{{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}}\
         table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}}\
         th{{background:#f5f5f5}}.muted{{color:#777}}.blocked{{color:#b42318}}.human{{color:#b54708}}</style>\
         <h1>研究过程报告 · {p}</h1><p class=\"muted\">由 Mesa 于 {t} 按本项目的研究记录导出。只含在 Mesa 里运行过的 AI 与在 Mesa 里做出的决定；\
         {d}。这是透明说明，不用于规避 AI 生成内容检测。</p>",
        p = esc(&project),
        t = chrono::Local::now().format("%Y-%m-%d %H:%M"),
        d = if details { "文末按作者选择附了任务书与对话原文（已去掉密钥）" } else { "不含对话原文" },
    );
    let blocked: usize = checks.values().flatten().filter(|c| c.status == "blocked").count();
    let needs: usize = checks.values().flatten().filter(|c| c.status == "needs_human").count();
    html.push_str(&format!(
        "<h2>人机分工</h2><ul><li>AI 运行 {} 次，用过：{}。</li>\
         <li>人保存进项目 / 采纳 {} 次；逐条裁决 {} 条、审查报告逐条决定 {} 条（都只能由人做出）。</li>\
         <li>核验存档里拦下 {} 条、交人判断 {} 条（处理结果见逐条裁决）。</li></ul>",
        runs.len(),
        esc(&tools_list(&runs, false).join("；")),
        accepts.len(),
        verdicts,
        decisions,
        blocked,
        needs
    ));
    html.push_str("<h2>AI 运行时间线</h2><table><tr><th>时间</th><th>用途</th><th>AI 工具</th><th>模型</th><th>结果</th><th>核验</th><th>任务书指纹</th></tr>");
    for r in &runs {
        let status = match r.status.as_str() {
            "completed" => "完成",
            "failed" => "失败",
            "stopped" => "停止",
            other => other,
        };
        let check = r
            .checks
            .map(|c| format!("通过 {} / 拦下 {} / 待判断 {}", c.passed, c.blocked, c.needs_human))
            .unwrap_or_default();
        let task = r
            .task
            .as_ref()
            .map(|t| format!("{} · {}", t.source, t.sha256.chars().take(12).collect::<String>()))
            .unwrap_or_default();
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&r.created_at.chars().take(16).collect::<String>().replace('T', " ")),
            esc(&r.purpose),
            esc(&agent_label(&r.agent)),
            esc(&if r.models.is_empty() { "（未记录）".to_string() } else { r.models.join("、") }),
            status,
            esc(&check),
            esc(&task)
        ));
    }
    if runs.is_empty() {
        html.push_str("<tr><td colspan=\"7\" class=\"muted\">还没有运行记录</td></tr>");
    }
    html.push_str("</table><h2>人的决定（保存进项目 / 采纳）</h2><table><tr><th>时间</th><th>对象</th><th>文件数</th><th>备注</th></tr>");
    for a in &accepts {
        let files = a.paths.iter().filter(|p| !p.trim().is_empty() && p.trim() != ".").count();
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&a.decided_at.chars().take(16).collect::<String>().replace('T', " ")),
            esc(&a.goal_name),
            files,
            esc(&a.note)
        ));
    }
    if accepts.is_empty() {
        html.push_str("<tr><td colspan=\"4\" class=\"muted\">还没有记录</td></tr>");
    }
    html.push_str("</table><h2>核验中拦下与交人判断的条目</h2>");
    let mut listed = 0;
    let mut list = String::from("<table><tr><th>状态</th><th>条目</th><th>位置</th><th>说明</th></tr>");
    for items in checks.values() {
        for c in items.iter().filter(|c| c.status != "passed") {
            if listed >= 200 {
                break;
            }
            listed += 1;
            let (cls, label) = if c.status == "blocked" { ("blocked", "拦下") } else { ("human", "待你判断") };
            let loc = c
                .target
                .as_ref()
                .map(|t| match t.line {
                    Some(l) => format!("{}:{l}", t.file),
                    None => t.file.clone(),
                })
                .unwrap_or_default();
            let detail = c.evidence.as_ref().and_then(|e| e.detail.clone()).unwrap_or_default();
            list.push_str(&format!(
                "<tr><td class=\"{cls}\">{label}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                esc(&c.title),
                esc(&loc),
                esc(&detail)
            ));
        }
    }
    list.push_str("</table>");
    if listed == 0 {
        html.push_str("<p class=\"muted\">核验存档里没有拦下或待判断的条目（或还没有跑过核验）。</p>");
    } else {
        html.push_str(&list);
    }
    if details {
        html.push_str("<h2>任务书与对话原文</h2><p class=\"muted\">按你的选择附上；都已去掉已保存的密钥与常见密钥前缀，超长的截断。</p>");
        for r in &runs {
            html.push_str(&format!(
                "<details><summary>{} · {} · {}</summary>",
                esc(&r.created_at.chars().take(16).collect::<String>().replace('T', " ")),
                esc(&r.purpose),
                esc(&agent_label(&r.agent))
            ));
            match r.task.as_ref().and_then(|t| fs::read_to_string(root.join(&t.archived)).ok()) {
                Some(text) => html.push_str(&format!("<h3>任务书（{}）</h3><pre>{}</pre>", esc(&r.task.as_ref().unwrap().source), esc(&capped(&text)))),
                None => html.push_str("<p class=\"muted\">没有存下任务书。</p>"),
            }
            match r.session_id.as_deref().and_then(|sid| crate::sessions::session_markdown(&r.agent, sid)) {
                Some(md) => html.push_str(&format!("<h3>对话原文</h3><pre>{}</pre>", esc(&capped(&md)))),
                None => html.push_str("<p class=\"muted\">找不到这次的对话文件（可能已被 CLI 清理）。</p>"),
            }
            html.push_str("</details>");
        }
    }
    html.push_str("</html>\n");
    redact(&html)
}

#[tauri::command]
pub async fn research_export(path: String, kind: String, details: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.join(".ccode").is_dir() {
            return Err("不是 Mesa 项目文件夹".to_string());
        }
        let name = crate::paths::sanitize_fs_name(&project_name(&root)).unwrap_or_else(|_| "project".into());
        let dir = exports_dir()?;
        let out = match kind.as_str() {
            "ai_statement" => {
                let out = dir.join(format!("{name}-AI使用声明草稿-{}.md", stamp()));
                let text = render_ai_statement(&project_name(&root), &read_records_at(&root));
                crate::storage::atomic_write(&out, redact(&text).as_bytes(), false)?;
                out
            }
            "repro_pack" => {
                let out = dir.join(format!("{name}-复现包-{}.zip", stamp()));
                write_repro_pack(&root, &out)?;
                out
            }
            "process_report" => {
                let out = dir.join(format!("{name}-研究过程报告-{}.html", stamp()));
                crate::storage::atomic_write(&out, render_process_report(&root, details.unwrap_or(false)).as_bytes(), false)?;
                out
            }
            _ => return Err("未知的导出类型".to_string()),
        };
        crate::local_stats::record_export();
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research_record::{append_run_record_at, CheckCounts};

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-export-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".ccode")).unwrap();
        dir
    }

    fn record(run_id: &str, purpose: &str, agent: &str, models: &[&str], day: &str) -> RunRecord {
        RunRecord {
            v: 1,
            kind: "run".into(),
            run_id: run_id.into(),
            task_kind: "pipeline_step".into(),
            purpose: purpose.into(),
            agent: agent.into(),
            models: models.iter().map(|m| m.to_string()).collect(),
            created_at: format!("{day}T08:00:00Z"),
            status: "completed".into(),
            ..RunRecord::default()
        }
    }

    #[test]
    fn ai_statement_lists_tools_and_purposes_in_first_use_order() {
        let records = vec![
            record("r2", "研究流程：综述初稿", "codex", &["gpt-5"], "2026-11-03"),
            record("r1", "研究流程：文献检索与筛选", "claude-code", &["claude-opus"], "2026-11-01"),
            record("r3", "研究流程：综述初稿", "claude-code", &["claude-sonnet"], "2026-11-04"),
        ];
        let text = render_ai_statement("我的课题", &records);
        assert!(text.contains("作者使用了 Claude Code（claude-opus、claude-sonnet）；Codex（gpt-5），用于文献检索与筛选、综述初稿。"));
        assert!(text.contains("used Claude Code (claude-opus, claude-sonnet); Codex (gpt-5) for: 文献检索与筛选; 综述初稿"), "英文段用半角标点");
        assert!(text.contains("## English"));
        assert!(text.contains("不能用于规避"));
        assert!(text.contains("| 研究流程：综述初稿 | Codex | gpt-5 | 1 | 2026-11-03 |"));
        assert!(render_ai_statement("x", &[]).contains("还没有 AI 运行记录"));
    }

    #[test]
    fn repro_pack_takes_code_and_records_but_only_hashes_data() {
        let root = temp_root("pack");
        for (p, body) in [
            ("scripts/clean.py", "print('x')\n"),
            ("references.bib", "@article{a, title={T}}\n"),
            ("data/raw.csv", "a,b\n1,2\n"),
            ("papers/paper.pdf", "%PDF"),
            ("papers/helper.py", "x=1\n"),
            ("manuscript/draft.md", "# 草稿\n"),
            (".ccode/record.jsonl", "{}\n"),
            (".ccode/checks/runs/r1.jsonl", "{}\n"),
            ("node_modules/x/y.js", "x"),
        ] {
            let path = root.join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        let (include, data) = pack_selection(&root);
        assert_eq!(
            include,
            vec![".ccode/checks/runs/r1.jsonl", ".ccode/record.jsonl", "references.bib", "scripts/clean.py"]
        );
        assert_eq!(data, vec!["data/raw.csv"]);
        let out = root.join("pack.zip");
        assert_eq!(write_repro_pack(&root, &out).unwrap(), (4, 1));
        let mut zip = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        let mut manifest = String::new();
        zip.by_name("MANIFEST.md").unwrap().read_to_string(&mut manifest).unwrap();
        assert!(manifest.contains("| `data/raw.csv` | 8 | "));
        assert!(zip.by_name("data/raw.csv").is_err());
    }

    #[test]
    fn process_report_counts_human_decisions_and_escapes() {
        let root = temp_root("report");
        let mut r = record("r1", "研究流程：<综述>", "claude-code", &["opus"], "2026-11-01");
        r.checks = Some(CheckCounts { passed: 2, blocked: 1, needs_human: 0 });
        append_run_record_at(&root, &r).unwrap();
        fs::create_dir_all(root.join("manuscript")).unwrap();
        fs::write(
            root.join("manuscript/verification-decisions.md"),
            "- V001 | 位置：a:1 | 裁决：接受 | 依据：对过原文\n- V002 | 位置：a:2 | 裁决：待裁决 | 依据：\n",
        )
        .unwrap();
        fs::write(root.join("manuscript/review-report.md"), "## R001\n决定：修改：缩窄\n## R002\n决定：\n").unwrap();
        fs::create_dir_all(root.join(".ccode/checks/runs")).unwrap();
        fs::write(
            root.join(".ccode/checks/runs/r1.jsonl"),
            r#"{"id":"Q1","kind":"quote_in_source","status":"blocked","title":"[@a] 原文里找不到","checker":"script:x"}"#,
        )
        .unwrap();
        let html = render_process_report(&root, false);
        assert!(html.contains("逐条裁决 1 条、审查报告逐条决定 1 条"));
        assert!(html.contains("研究流程：&lt;综述&gt;"));
        assert!(html.contains("<td class=\"blocked\">拦下</td><td>[@a] 原文里找不到</td>"));
        assert!(html.contains("通过 2 / 拦下 1 / 待判断 0"));
        assert!(!html.contains("任务书与对话原文"), "默认不附原文");
    }

    #[test]
    fn process_report_details_embed_archived_task_and_say_when_transcript_missing() {
        let root = temp_root("details");
        let mut r = record("r9", "研究流程：综述初稿", "codex", &["gpt-5"], "2026-11-02");
        r.task = Some(crate::research_record::archive_task(&root, "r9", "TASK.md", "# 写初稿\n<按大纲写>").unwrap());
        r.session_id = Some("no-such-session".into());
        append_run_record_at(&root, &r).unwrap();
        let html = render_process_report(&root, true);
        assert!(html.contains("TASK.md · "));
        assert!(html.contains("<h3>任务书（TASK.md）</h3><pre># 写初稿\n&lt;按大纲写&gt;</pre>"));
        assert!(html.contains("找不到这次的对话文件"));
        assert!(html.contains("文末按作者选择附了任务书与对话原文"));
        assert!(!html.contains("；不含对话原文"), "附了原文就不能再说不含");
    }
}
