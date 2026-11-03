//! 看一眼（2026-11-03 项目内协作一期，docs/design-project-coordination.md）：同一项目里的 Agent 只读看彼此在做什么。
//!
//! 走随包 helper：`mesa_helper peek agents|runs|changes`。Mesa 拉起 Agent 时注入 `MESA_PEEK_TOOL`（helper 路径）与
//! `MESA_RUN_ID`（这次对话的 Run）；这里只读打开 app.db（runs::peek_context），只看同一项目，不列内部后台对话与登录标签。
//! 改动只给文件、加减行数与片段（有上限），不给整个文件；输出整段过 `redact_sensitive_text`。

use crate::runs::RunDto;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 已结束的只列这么多天内的
const RECENT_DAYS: i64 = 3;
/// 最多列几个同伴
const MAX_PEERS: usize = 12;
/// 改动片段最多几行：指定了 --file 时 300，没指定时 120（只是先给个概貌）
const MAX_DIFF_LINES: usize = 300;
const OVERVIEW_DIFF_LINES: usize = 120;
/// 没指定 --file 时，加减超过这么多行的文件（多半是生成的数据、清单）只列行数、不给片段
/// （2026-11-03 Codex 干跑实证：几千行的 RIS / JSON 把 300 行配额占满，一次看改动花了四万 token）
const SMALL_CHANGE_LINES: u64 = 150;
const MAX_EVENTS: usize = 8;

pub const TOOL_ENV: &str = "MESA_PEEK_TOOL";
pub const RUN_ENV: &str = "MESA_RUN_ID";

const USAGE: &str = "用法（只读，只看同一项目；Windows PowerShell 把 \"$MESA_PEEK_TOOL\" 写成 & $env:MESA_PEEK_TOOL）：
  \"$MESA_PEEK_TOOL\" peek agents                          同项目里其他工作在做什么（不含你自己）
  \"$MESA_PEEK_TOOL\" peek runs [--worker 名]               运行事实：开始 / 结束 / 退出码、最近事件、没通过的核验
  \"$MESA_PEEK_TOOL\" peek changes [--worker 名] [--file 路径]  改了哪些文件、各加减几行；指定工作者时给改动片段
  \"$MESA_PEEK_TOOL\" peek mail                            你发出的和收到的留话、送没送到
  \"$MESA_PEEK_TOOL\" tell --to 名 \"要说的话\"               给同项目另一段工作留话（或 --file 文件），对方空闲时 Mesa 送进它的对话
--worker / --to 可写步骤名、目标名、Agent 名、分支名或编号开头几位；--worker 写「我」看自己。
别人工作副本里的文件只读不改；要用它们的产物，等评审采纳进项目再读。";

/// 一个同伴（或自己）的概况
#[derive(Debug, Clone)]
pub(crate) struct Worker {
    pub run: RunDto,
    /// 做什么：流程步骤名 / 目标名 / 对话
    pub label: String,
    /// 工作副本位置（项目内写相对路径，项目根写「项目根」）
    pub place: String,
    pub branch: Option<String>,
    pub checks: crate::research_record::CheckCounts,
    /// 等人回答的问题数（.ccode/help-wanted.md 里还没「已答」的）
    pub help_open: usize,
    pub is_me: bool,
}

fn agent_name(agent: &str) -> String {
    crate::agent_specs::agent_spec(agent)
        .map(|s| s.display_name.to_string())
        .unwrap_or_else(|| agent.to_string())
}

fn looks_like_path(s: &str) -> bool {
    s.contains('/') || s.contains('\\')
}

/// 做什么：研究记录同一口径（purpose_of），目标 / 对话再带上名字
pub(crate) fn label_of(run: &RunDto, root: &Path) -> String {
    let purpose = crate::research_record::purpose_of(run, root);
    match run.task_ref.as_deref().map(str::trim) {
        Some(r) if !r.is_empty() && !looks_like_path(r) && !purpose.contains(r) && run.task_kind != "pipeline_step" => {
            format!("{purpose}：{r}")
        }
        _ => purpose,
    }
}

fn place_of(run: &RunDto, root: &Path) -> String {
    let iso = Path::new(&run.isolation_path);
    if crate::paths::same_path(&run.isolation_path, &root.to_string_lossy()) {
        return "项目根".into();
    }
    match iso.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            let full = crate::paths::strip_verbatim(iso.to_path_buf());
            match crate::dirs::home_dir().and_then(|h| full.strip_prefix(&h).ok().map(Path::to_path_buf)) {
                Some(rel) => format!("~/{}", rel.to_string_lossy().replace('\\', "/")),
                None => full.to_string_lossy().into_owned(),
            }
        }
    }
}

fn status_text(run: &RunDto) -> String {
    if run.closed_at.is_some() {
        let mut s = "已结束".to_string();
        if let Some(code) = run.exit_code {
            s.push_str(&format!("（退出码 {code}）"));
        }
        if let Some(reason) = run.close_reason.as_deref().filter(|r| !r.is_empty()) {
            s.push_str(&format!("（{reason}）"));
        }
        return s;
    }
    match run.status.as_str() {
        "starting" | "running" => "进行中".into(),
        other => format!("开着（{other}）"),
    }
}

fn help_open_at(dir: &Path) -> usize {
    std::fs::read_to_string(dir.join(".ccode").join("help-wanted.md"))
        .map(|t| crate::help_requests::parse_items(&t).iter().filter(|i| i.answer.is_none()).count())
        .unwrap_or(0)
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    crate::workspaces::run_git(dir, args, Duration::from_secs(15)).ok()
}

fn branch_of(dir: &Path) -> Option<String> {
    git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty() && b != "HEAD")
}

/// 同伴的取舍：同项目、不是内部后台、不是登录；开着的都列，已结束的只列 RECENT_DAYS 天内；开着的在前，最多 MAX_PEERS 个
pub(crate) fn pick_peers(me: &RunDto, runs: Vec<RunDto>, now: chrono::DateTime<chrono::Utc>) -> Vec<RunDto> {
    let recent = |r: &RunDto| match r.closed_at.as_deref() {
        None => true,
        Some(t) => chrono::DateTime::parse_from_rfc3339(t)
            .map(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)).num_days() < RECENT_DAYS)
            .unwrap_or(false),
    };
    let mut out: Vec<RunDto> = runs
        .into_iter()
        .filter(|r| r.id != me.id && !r.internal && r.task_kind != "login" && recent(r))
        .collect();
    out.sort_by(|a, b| a.closed_at.is_some().cmp(&b.closed_at.is_some()).then(b.created_at.cmp(&a.created_at)));
    out.truncate(MAX_PEERS);
    out
}

fn worker(run: RunDto, root: &Path, is_me: bool) -> Worker {
    let dir = PathBuf::from(&run.isolation_path);
    let checks = crate::research_record::count_checks(&crate::research_record::read_checks_at(&dir).items);
    Worker {
        label: label_of(&run, root),
        place: place_of(&run, root),
        branch: if dir.is_dir() { branch_of(&dir) } else { None },
        checks,
        help_open: help_open_at(&dir),
        is_me,
        run,
    }
}

/// --worker 的匹配：「我」= 自己；否则按编号开头（≥4 位）、做什么、Agent、分支、工作副本目录名
pub(crate) fn select<'a>(workers: &'a [Worker], key: &str) -> Result<&'a Worker, String> {
    let key = key.trim();
    if matches!(key, "我" | "me" | "self") {
        return workers.iter().find(|w| w.is_me).ok_or("找不到你自己的记录".into());
    }
    let lower = key.to_lowercase();
    let hits: Vec<&Worker> = workers
        .iter()
        .filter(|w| {
            (key.len() >= 4 && w.run.id.starts_with(key))
                || w.label.contains(key)
                || agent_name(&w.run.agent).to_lowercase().contains(&lower)
                || w.run.agent.eq_ignore_ascii_case(key)
                || w.branch.as_deref() == Some(key)
                || Path::new(&w.place).file_name().is_some_and(|n| n.to_string_lossy() == key)
        })
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("没有叫「{key}」的工作。可以看的：{}", names(workers))),
        many => Err(format!(
            "「{key}」对上了 {} 个，写得再具体些（比如编号开头几位）：{}",
            many.len(),
            many.iter().map(|w| format!("{}（{}）", w.label, short_id(&w.run.id))).collect::<Vec<_>>().join("、")
        )),
    }
}

fn names(workers: &[Worker]) -> String {
    workers
        .iter()
        .map(|w| if w.is_me { format!("{}（你自己）", w.label) } else { format!("{}（{}）", w.label, short_id(&w.run.id)) })
        .collect::<Vec<_>>()
        .join("、")
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn time_text(t: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(t)
        .map(|t| t.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| t.to_string())
}

pub(crate) fn render_agents(workers: &[Worker]) -> String {
    let peers: Vec<&Worker> = workers.iter().filter(|w| !w.is_me).collect();
    if peers.is_empty() {
        return "同项目里现在没有别的工作（开着的，或 3 天内结束的）。".into();
    }
    let mut out = format!("同项目的其他工作 {} 个（只读，不会打扰它们）：\n", peers.len());
    for (i, w) in peers.iter().enumerate() {
        out.push_str(&format!(
            "{}. {} · {} · {} · {} 开始 · 编号 {}\n",
            i + 1,
            w.label,
            agent_name(&w.run.agent),
            status_text(&w.run),
            time_text(&w.run.created_at),
            short_id(&w.run.id)
        ));
        let mut line = format!("   工作副本：{}", w.place);
        if let Some(b) = &w.branch {
            line.push_str(&format!("（分支 {b}）"));
        }
        out.push_str(&line);
        out.push('\n');
        let c = &w.checks;
        if c.passed + c.blocked + c.needs_human > 0 || w.help_open > 0 {
            out.push_str(&format!(
                "   核验：拦下 {} / 待人判断 {} / 通过 {}；等人回答的问题 {} 个\n",
                c.blocked, c.needs_human, c.passed, w.help_open
            ));
        }
    }
    out.push_str("细看：peek runs --worker 编号或名字；peek changes --worker 编号或名字。");
    out
}

pub(crate) fn render_runs(w: &Worker, events: &[(String, String, Option<String>)], checks: &[crate::research_record::CheckItem]) -> String {
    let mut out = format!(
        "{}{} · {} · {}\n开始 {}",
        w.label,
        if w.is_me { "（你自己）" } else { "" },
        agent_name(&w.run.agent),
        status_text(&w.run),
        time_text(&w.run.created_at)
    );
    if let Some(t) = &w.run.closed_at {
        out.push_str(&format!("，结束 {}", time_text(t)));
    }
    out.push('\n');
    if !events.is_empty() {
        out.push_str("最近事件：\n");
        for (kind, at, payload) in events {
            let p = payload.as_deref().map(|p| p.replace('\n', " ")).unwrap_or_default();
            let p: String = p.chars().take(160).collect();
            out.push_str(&format!("  {} {}{}\n", time_text(at), kind, if p.is_empty() { String::new() } else { format!("：{p}") }));
        }
    }
    let open: Vec<&crate::research_record::CheckItem> = checks.iter().filter(|c| c.status != "passed").collect();
    if open.is_empty() {
        out.push_str(if checks.is_empty() { "没有核验记录。\n" } else { "核验全部通过（脚本判的通过，评审时仍由人看）。\n" });
    } else {
        out.push_str("没通过的核验：\n");
        for c in open {
            let tag = if c.status == "blocked" { "拦下" } else { "待人判断" };
            let at = c
                .target
                .as_ref()
                .and_then(|t| serde_json::to_value(t).ok())
                .and_then(|v| {
                    let file = v.get("file")?.as_str()?.to_string();
                    Some(match v.get("line").and_then(|l| l.as_u64()) {
                        Some(l) => format!("（{file}:{l}）"),
                        None => format!("（{file}）"),
                    })
                })
                .unwrap_or_default();
            out.push_str(&format!("  [{tag}] {}{at}\n", c.title));
        }
    }
    out
}

/// 改动的对照点：工作副本就是项目根时对 HEAD；否则对它和项目根当前分支的分叉点（提交了的和没提交的都算）
fn diff_base(dir: &Path, root: &Path) -> Option<String> {
    if crate::paths::same_path(&dir.to_string_lossy(), &root.to_string_lossy()) {
        return Some("HEAD".into());
    }
    let main = branch_of(root).unwrap_or_else(|| "HEAD".into());
    git(dir, &["merge-base", "HEAD", &main]).filter(|s| !s.is_empty()).or_else(|| Some("HEAD".into()))
}

fn is_git_tree(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// .ccode/ 是 Mesa 与 Agent 的工作记录，不算改动
fn ours(path: &str) -> bool {
    !path.starts_with(".ccode/")
}

/// 一个工作改了哪些文件：（路径, 加, 减）与没跟踪的新文件
pub(crate) fn changed_files(dir: &Path, root: &Path) -> Result<(Vec<(String, String, String)>, Vec<String>), String> {
    if !dir.is_dir() {
        return Err("工作副本已经不在了（可能已归档）".into());
    }
    if !is_git_tree(dir) {
        return Err("不在 Git 工作树里，看不了改动；去评审页看".into());
    }
    let base = diff_base(dir, root).unwrap_or_else(|| "HEAD".into());
    let numstat = git(dir, &["diff", "--numstat", &base]).unwrap_or_default();
    let files = numstat
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let (a, d, p) = (it.next()?, it.next()?, it.next()?);
            ours(p).then(|| (p.to_string(), a.to_string(), d.to_string()))
        })
        .collect();
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .filter(|p| ours(p))
        .map(str::to_string)
        .collect();
    Ok((files, untracked))
}

fn render_file_list(files: &[(String, String, String)], untracked: &[String]) -> String {
    if files.is_empty() && untracked.is_empty() {
        return "   没有改动\n".into();
    }
    let mut out = String::new();
    for (p, a, d) in files {
        let n = if a == "-" { "二进制".to_string() } else { format!("+{a} -{d}") };
        out.push_str(&format!("   {p}  {n}\n"));
    }
    for p in untracked {
        out.push_str(&format!("   {p}  新文件（还没提交）\n"));
    }
    out
}

/// 没指定文件时给哪些文件片段：文本、加减不超过 SMALL_CHANGE_LINES 行
pub(crate) fn small_changes(files: &[(String, String, String)]) -> Vec<String> {
    files
        .iter()
        .filter(|(_, a, d)| match (a.parse::<u64>(), d.parse::<u64>()) {
            (Ok(a), Ok(d)) => a + d <= SMALL_CHANGE_LINES,
            _ => false,
        })
        .map(|(p, _, _)| p.clone())
        .collect()
}

/// 改动片段：-U2，限 cap 行；files 为空 = 不限文件
fn diff_hunks(dir: &Path, root: &Path, files: &[String], cap: usize) -> String {
    let base = diff_base(dir, root).unwrap_or_else(|| "HEAD".into());
    let mut args = vec!["diff", "--no-color", "-U2", base.as_str()];
    if !files.is_empty() {
        args.push("--");
        args.extend(files.iter().map(String::as_str));
    }
    let text = crate::workspaces::run_git_raw(dir, &args).unwrap_or_default();
    let mut out = String::new();
    let mut skipping = false;
    let mut n = 0;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            skipping = !ours(rest);
        }
        if skipping {
            continue;
        }
        if n >= cap {
            out.push_str(&format!("…（片段超过 {cap} 行，后面省略；用 --file 只看一个文件）\n"));
            break;
        }
        out.push_str(line);
        out.push('\n');
        n += 1;
    }
    out
}

struct Args {
    cmd: String,
    worker: Option<String>,
    file: Option<String>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut it = args.iter();
    let cmd = it.next().cloned().unwrap_or_default();
    let mut out = Args { cmd, worker: None, file: None };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--worker" => out.worker = Some(it.next().ok_or("--worker 后面要写名字")?.clone()),
            "--file" => out.file = Some(it.next().ok_or("--file 后面要写路径")?.clone()),
            other => return Err(format!("不认识的参数：{other}")),
        }
    }
    Ok(out)
}

/// `tell --to 名 "话"` / `tell --to 名 --file 路径`：写进自己工作目录的发件箱（project_mail.rs）
fn run_tell(args: &[String], me: &RunDto, workers: &[Worker]) -> Result<String, String> {
    let mut to: Option<String> = None;
    let mut file: Option<String> = None;
    let mut words: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--to" => to = Some(it.next().ok_or("--to 后面要写对方名字")?.clone()),
            "--file" => file = Some(it.next().ok_or("--file 后面要写路径")?.clone()),
            _ => words.push(a.clone()),
        }
    }
    let to = to.ok_or("要写给谁：--to 对方名字（peek agents 里能看到）")?;
    let text = match file {
        Some(f) => std::fs::read_to_string(&f).map_err(|e| format!("读不了 {f}：{e}"))?,
        None => words.join(" "),
    };
    let target = select(workers, &to)?;
    if target.is_me {
        return Err("不用给自己留话".into());
    }
    if target.run.closed_at.is_some() {
        return Err(format!("「{}」已经结束，留话送不到；要交代的写进你的报告", target.label));
    }
    crate::project_mail::append_outbox(Path::new(&me.isolation_path), &me.id, &target.run.id, &text)?;
    Ok(format!(
        "已给「{}」留话：它空闲时 Mesa 会送进它的对话；人能在工作台看到、能撤回。送没送到：peek mail",
        target.label
    ))
}

fn render_mail(me: &RunDto, mails: &[crate::project_mail::MailDto]) -> String {
    let mine: Vec<&crate::project_mail::MailDto> = mails.iter().filter(|m| m.from_run == me.id || m.to_run == me.id).collect();
    if mine.is_empty() {
        return "没有你发出或收到的留话（7 天内）。".into();
    }
    let mut out = String::new();
    for m in mine {
        let status = match m.status.as_str() {
            "delivered" => "已送到",
            "withdrawn" => "人撤回了",
            _ if !m.to_open => "对方已结束，送不到",
            _ => "等对方空闲",
        };
        let (dir, who) = if m.from_run == me.id { ("发给", &m.to_label) } else { ("来自", &m.from_label) };
        let text: String = m.text.chars().take(200).collect();
        out.push_str(&format!("{} {}「{}」 · {}：{}\n", time_text(&m.at), dir, who, status, text.replace('\n', " ")));
    }
    out
}

fn run_cli(args: &[String]) -> Result<String, String> {
    let is_tell = args.first().map(String::as_str) == Some("tell");
    let a = if is_tell { Args { cmd: "tell".into(), worker: None, file: None } } else { parse_args(args)? };
    if !matches!(a.cmd.as_str(), "agents" | "runs" | "changes" | "mail" | "tell") {
        return Err(USAGE.into());
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let (me, runs) = crate::runs::peek_context(std::env::var(RUN_ENV).ok().as_deref(), &cwd)?;
    let root = PathBuf::from(me.project_root.clone().unwrap_or_default());
    if a.cmd == "mail" {
        return Ok(render_mail(&me, &crate::project_mail::collect(&root, &runs)));
    }
    let mut workers = vec![worker(me.clone(), &root, true)];
    workers.extend(pick_peers(&me, runs, chrono::Utc::now()).into_iter().map(|r| worker(r, &root, false)));
    if is_tell {
        return run_tell(&args[1..], &me, &workers);
    }
    match a.cmd.as_str() {
        "agents" => Ok(render_agents(&workers)),
        "runs" => {
            let chosen: Vec<&Worker> = match &a.worker {
                Some(k) => vec![select(&workers, k)?],
                None => workers.iter().filter(|w| !w.is_me).collect(),
            };
            if chosen.is_empty() {
                return Ok("同项目里现在没有别的工作。看自己：peek runs --worker 我".into());
            }
            let mut out = String::new();
            for w in chosen {
                let events = crate::runs::peek_events(&w.run.id, MAX_EVENTS).unwrap_or_default();
                let checks = crate::research_record::read_checks_at(Path::new(&w.run.isolation_path)).items;
                out.push_str(&render_runs(w, &events, &checks));
                out.push('\n');
            }
            Ok(out)
        }
        _ => {
            match &a.worker {
                Some(k) => {
                    let w = select(&workers, k)?;
                    let dir = PathBuf::from(&w.run.isolation_path);
                    let (files, untracked) = changed_files(&dir, &root)?;
                    let mut out = format!("{} 的改动（工作副本 {}）：\n", w.label, w.place);
                    out.push_str(&render_file_list(&files, &untracked));
                    match a.file.as_deref() {
                        Some(f) => {
                            out.push_str(&format!("\n{f} 的改动片段：\n"));
                            out.push_str(&diff_hunks(&dir, &root, &[f.to_string()], MAX_DIFF_LINES));
                        }
                        None => {
                            let small = small_changes(&files);
                            if !small.is_empty() {
                                out.push_str("\n改动片段（只给改得少的文本文件）：\n");
                                out.push_str(&diff_hunks(&dir, &root, &small, OVERVIEW_DIFF_LINES));
                            }
                            if small.len() < files.len() {
                                out.push_str("\n其余改动较大的只列了行数（多半是生成的数据或清单）；要看某一个：peek changes --worker 编号 --file 路径\n");
                            }
                        }
                    }
                    Ok(out)
                }
                None => {
                    let mut out = String::new();
                    for w in workers.iter().filter(|w| !w.is_me) {
                        out.push_str(&format!("{}（{}，工作副本 {}）：\n", w.label, short_id(&w.run.id), w.place));
                        match changed_files(Path::new(&w.run.isolation_path), &root) {
                            Ok((files, untracked)) => out.push_str(&render_file_list(&files, &untracked)),
                            Err(e) => out.push_str(&format!("   {e}\n")),
                        }
                    }
                    if out.is_empty() {
                        out.push_str("同项目里现在没有别的工作。看自己：peek changes --worker 我\n");
                    }
                    Ok(out)
                }
            }
        }
    }
}

/// `mesa_helper peek …` 的入口：结果打到 stdout（整段脱敏），错误打到 stderr，返回退出码
pub fn helper_peek_cli(args: &[String]) -> i32 {
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        println!("{USAGE}");
        return 0;
    }
    match run_cli(args) {
        Ok(text) => {
            println!("{}", crate::sessions::redact_sensitive_text(text.trim_end()));
            0
        }
        Err(e) => {
            eprintln!("{}", crate::sessions::redact_sensitive_text(&e));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, kind: &str, iso: &str, created: &str, closed: Option<&str>) -> RunDto {
        RunDto {
            id: id.into(),
            project_root: Some("/p".into()),
            task_kind: kind.into(),
            task_ref: None,
            isolation_path: iso.into(),
            runtime: "local_cli".into(),
            agent: "codex".into(),
            profile_id: None,
            permission: "write_tree".into(),
            reuse_key: None,
            session_id: None,
            internal: false,
            sentinel: false,
            created_at: created.into(),
            closed_at: closed.map(str::to_string),
            status: if closed.is_some() { "completed".into() } else { "running".into() },
            exit_code: None,
            close_reason: None,
            task_id: String::new(),
            custom_runtime_id: None,
            project_id: None,
            capabilities: crate::runtime::capabilities(crate::runtime::RuntimeKind::LocalCli),
        }
    }

    #[test]
    fn peers_skip_me_internal_login_and_old_closed_open_first() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-03T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let me = run("me", "pipeline_step", "/p/a", "2026-11-03T10:00:00Z", None);
        let mut internal = run("int", "scratch", "/p", "2026-11-03T11:00:00Z", None);
        internal.internal = true;
        let runs = vec![
            me.clone(),
            internal,
            run("login1", "login", "/p", "2026-11-03T11:00:00Z", None),
            run("old", "scratch", "/p", "2026-10-20T10:00:00Z", Some("2026-10-25T10:00:00Z")),
            run("done", "scratch", "/p", "2026-11-03T09:00:00Z", Some("2026-11-03T09:30:00Z")),
            run("open1", "pipeline_step", "/p/b", "2026-11-02T10:00:00Z", None),
            run("open2", "free_research", "/p/c", "2026-11-03T08:00:00Z", None),
        ];
        let ids: Vec<String> = pick_peers(&me, runs, now).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["open2", "open1", "done"]);
    }

    fn w(id: &str, label: &str, me: bool) -> Worker {
        Worker {
            run: run(id, "pipeline_step", &format!("/p/.wt/{label}"), "2026-11-03T10:00:00Z", None),
            label: label.into(),
            place: format!(".wt/{label}"),
            branch: Some(format!("ccode/{label}")),
            checks: Default::default(),
            help_open: 0,
            is_me: me,
        }
    }

    #[test]
    fn select_by_me_id_label_branch_and_reports_ambiguity() {
        let ws = vec![w("aaaa1111", "研究流程：文献精读", true), w("bbbb2222", "研究流程：综述初稿", false), w("bbbb3333", "研究流程：综述大纲", false)];
        assert_eq!(select(&ws, "我").unwrap().run.id, "aaaa1111");
        assert_eq!(select(&ws, "初稿").unwrap().run.id, "bbbb2222");
        assert_eq!(select(&ws, "bbbb3").unwrap().run.id, "bbbb3333");
        assert_eq!(select(&ws, "ccode/研究流程：综述大纲").unwrap().run.id, "bbbb3333");
        assert!(select(&ws, "综述").unwrap_err().contains("对上了 2 个"));
        assert!(select(&ws, "不存在").unwrap_err().contains("可以看的"));
    }

    #[test]
    fn render_agents_lists_peers_with_checks_and_questions() {
        let mut peer = w("bbbb2222", "研究流程：综述初稿", false);
        peer.checks = crate::research_record::CheckCounts { passed: 3, blocked: 1, needs_human: 2 };
        peer.help_open = 1;
        let text = render_agents(&[w("aaaa1111", "研究流程：文献精读", true), peer]);
        assert!(text.contains("同项目的其他工作 1 个"), "{text}");
        assert!(text.contains("1. 研究流程：综述初稿 · Codex · 进行中"), "{text}");
        assert!(text.contains("分支 ccode/研究流程：综述初稿"), "{text}");
        assert!(text.contains("拦下 1 / 待人判断 2 / 通过 3；等人回答的问题 1 个"), "{text}");
        assert!(!text.contains("文献精读"), "不列自己：{text}");
        assert!(render_agents(&[w("a", "x", true)]).contains("没有别的工作"));
    }

    #[test]
    fn small_changes_skip_big_and_binary() {
        let files = vec![
            ("a.md".to_string(), "3".to_string(), "1".to_string()),
            ("papers/to-fetch.ris".to_string(), "3262".to_string(), "0".to_string()),
            ("fig.png".to_string(), "-".to_string(), "-".to_string()),
            ("b.py".to_string(), "100".to_string(), "50".to_string()),
        ];
        assert_eq!(small_changes(&files), ["a.md", "b.py"]);
    }

    #[cfg(unix)]
    #[test]
    fn changed_files_against_fork_point_skip_ccode_and_list_untracked() {
        let dir = std::env::temp_dir().join(format!("mesa-peek-{}", uuid::Uuid::new_v4()));
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let g = |d: &Path, args: &[&str]| crate::workspaces::run_git(d, args, Duration::from_secs(15)).unwrap();
        g(&root, &["init", "-q", "-b", "main"]);
        g(&root, &["config", "user.email", "t@t"]);
        g(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.md"), "一\n二\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "init"]);
        let wt = dir.join("wt");
        g(&root, &["worktree", "add", "-q", "-b", "ccode/x", wt.to_str().unwrap()]);
        // 提交了的和没提交的都算；.ccode/ 不算
        std::fs::write(wt.join("a.md"), "一\n二\n三\n").unwrap();
        g(&wt, &["commit", "-q", "-am", "x"]);
        std::fs::write(wt.join("a.md"), "一\n三\n").unwrap();
        std::fs::create_dir_all(wt.join(".ccode")).unwrap();
        std::fs::write(wt.join(".ccode/help-wanted.md"), "x").unwrap();
        std::fs::write(wt.join("new.csv"), "x").unwrap();
        let (files, untracked) = changed_files(&wt, &root).unwrap();
        assert_eq!(files, [("a.md".to_string(), "1".to_string(), "1".to_string())]);
        assert_eq!(untracked, ["new.csv"]);
        let hunks = diff_hunks(&wt, &root, &[], MAX_DIFF_LINES);
        assert!(hunks.contains("-二") && hunks.contains("+三"), "{hunks}");
        // 项目根自己：对 HEAD
        std::fs::write(root.join("a.md"), "改\n").unwrap();
        let (files, _) = changed_files(&root, &root).unwrap();
        assert_eq!(files.len(), 1);
        assert!(changed_files(&dir.join("nope"), &root).unwrap_err().contains("不在了"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
