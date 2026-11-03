//! Agent 人工请求（`.ccode/help-wanted.md`）：Agent 只会写文件，Mesa 负责看见、让人点一下就答。
//!
//! 每条问题是一个「- 」开头的行，下面缩进写固定字段（2026-11-02，design-attention-dispatch.md §4.1）：
//! `建议：B`、`A：选项 —— 后果`（A–D）、`不回时：…`、`类别：…`、`依据：…`；其余缩进行算补充说明。
//! 只有一行、没有字段的旧写法照样是一条问题。人在卡片上答了，Mesa 在该条下面加 `已答：…`，
//! 交给 Agent 时再加 `已送：…`；Agent 照办后删掉整条（文件只放没处理完的）。
//! 扫描范围：未归档工作区的工作树 + 其主仓根（聊想法在主仓进行）；无工作区的项目不扫。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub(crate) const HELP_WANTED_FILE: &str = ".ccode/help-wanted.md";
const MAX_ITEMS: usize = 20;
const FIELD_CAP: usize = 300;

/// 必须停下来问的七类加「一般」（2026-11-02，与 step-decisions.ts HELP_WANTED_RULE 同列）。写错的类别按「一般」算，不拒收
pub(crate) const CATEGORIES: [&str; 8] = ["范围", "数据", "合规", "对外", "花钱", "人写的内容", "保护路径", "一般"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpOptionDto {
    pub key: String,
    pub label: String,
    pub effect: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpItemDto {
    /// 问题原文的短哈希（同文同问加序号）：写回答时据此找回这一条
    pub id: String,
    pub question: String,
    /// 不认得的缩进行，按原顺序
    pub detail: Vec<String>,
    /// 指向一个存在的选项键；没写或指错为 None
    pub recommend: Option<String>,
    pub options: Vec<HelpOptionDto>,
    pub fallback: Option<String>,
    pub category: String,
    pub refs: Option<String>,
    /// 人在 Mesa 里的回答（`已答：` 行）
    pub answer: Option<String>,
    /// 交给 Agent 的时间（`已送：` 行）
    pub sent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpRequestDto {
    /// 来源根（工作树根或主仓根）
    pub root: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub repo_name: String,
    /// 项目根（主仓）：「以后同类照此办」写进这里的项目知识
    pub repo_path: String,
    pub items: Vec<HelpItemDto>,
}

/// 解析出的一条及它在文件里占的行（写回答时据此插行、删旧答）
#[derive(Debug)]
struct Block {
    item: HelpItemDto,
    last_line: usize,
    answer_lines: Vec<usize>,
}

fn cap(text: &str) -> String {
    text.trim().chars().take(FIELD_CAP).collect()
}

fn bullet_text(t: &str) -> Option<&str> {
    t.strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| {
            let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
            (digits > 0)
                .then(|| &t[digits..])
                .and_then(|rest| rest.strip_prefix(". ").or_else(|| rest.strip_prefix('、')))
        })
}

/// 「A：只要期刊 —— 后果」→ (A, 只要期刊, 后果)
fn option_line(c: &str) -> Option<HelpOptionDto> {
    let mut chars = c.chars();
    let key = chars.next()?.to_ascii_uppercase();
    if !('A'..='D').contains(&key) {
        return None;
    }
    let rest = chars.as_str().trim_start();
    let sep = rest.chars().next()?;
    if !matches!(sep, '：' | ':' | '.' | '、' | ')' | '）') {
        return None;
    }
    let body = rest[sep.len_utf8()..].trim();
    if body.is_empty() {
        return None;
    }
    let (label, effect) = match body.split_once("——").or_else(|| body.split_once(" — ")) {
        Some((l, e)) if !l.trim().is_empty() => (l, Some(cap(e)).filter(|e| !e.is_empty())),
        _ => (body, None),
    };
    Some(HelpOptionDto { key: key.to_string(), label: cap(label), effect })
}

/// 「标签：值」，标签不超过 6 个字
fn labeled(c: &str) -> Option<(&str, &str)> {
    let (label, value) = c.split_once('：').or_else(|| c.split_once(':'))?;
    let label = label.trim();
    (label.chars().count() <= 6 && !label.is_empty()).then_some((label, value.trim()))
}

fn item_id(question: &str, ordinal: usize) -> String {
    let digest = Sha256::digest(format!("{question}\n{ordinal}").as_bytes());
    format!("{digest:x}")[..12].to_string()
}

fn finish(open: &mut Option<Block>, seen: &mut std::collections::HashMap<String, usize>, out: &mut Vec<Block>) {
    let Some(mut block) = open.take() else { return };
    let n = seen.entry(block.item.question.clone()).or_insert(0);
    block.item.id = item_id(&block.item.question, *n);
    *n += 1;
    let keys: Vec<&str> = block.item.options.iter().map(|o| o.key.as_str()).collect();
    if block.item.recommend.as_deref().is_some_and(|r| !keys.contains(&r)) {
        block.item.recommend = None;
    }
    out.push(block);
}

/// 只收条目行；表格、普通段落不算（2026-10-22 实证：一张检索命中数表被拆成九条请求）。
/// 标题写着已拍板 / 已解决 / 已回复 / 备查的那一节整节跳过——那是记录，不是在等人回答的问题
fn parse_blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut open: Option<Block> = None;
    let mut seen = std::collections::HashMap::new();
    let mut answered_section = false;
    let mut budget = 32 * 1024usize;
    for (i, raw) in text.lines().enumerate() {
        budget = budget.saturating_sub(raw.len() + 1);
        if budget == 0 || out.len() >= MAX_ITEMS {
            break;
        }
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(heading) = t.strip_prefix('#') {
            finish(&mut open, &mut seen, &mut out);
            // 「已拍板」「已由人拍板」都算；「待你拍板」不算。旧写法的「记录事项（不需回复）」「——已闭环」也不是问题
            //（2026-11-03 用户截图：综述测试项目根的旧文件把记录事项与闭环条目数成 21 个待拍板）
            answered_section = [
                "已解决", "已回复", "已答复", "已处理", "已完成", "备查", "已闭环", "不需回复", "无需回复", "不用回复", "记录事项", "仅记录",
            ]
            .iter()
            .any(|w| heading.contains(w))
                || (heading.contains('已') && heading.contains("拍板"));
            continue;
        }
        if answered_section {
            continue;
        }
        let indented = raw.starts_with([' ', '\t']);
        if let (true, Some(block)) = (indented, open.as_mut()) {
            block.last_line = i;
            let c = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).unwrap_or(t).trim();
            if let Some(opt) = option_line(c) {
                if block.item.options.len() < 4 && !block.item.options.iter().any(|o| o.key == opt.key) {
                    block.item.options.push(opt);
                }
                continue;
            }
            match labeled(c) {
                Some(("建议" | "推荐", v)) => {
                    block.item.recommend = v
                        .chars()
                        .next()
                        .map(|ch| ch.to_ascii_uppercase().to_string())
                        .filter(|k| matches!(k.as_str(), "A" | "B" | "C" | "D"));
                }
                Some(("不回时" | "兜底" | "未回复" | "若未回复", v)) => block.item.fallback = Some(cap(v)),
                Some(("类别", v)) => {
                    block.item.category = CATEGORIES
                        .iter()
                        .find(|c| v.contains(**c))
                        .unwrap_or(&"一般")
                        .to_string();
                }
                Some(("依据", v)) => block.item.refs = Some(cap(v)),
                Some(("已答", v)) => {
                    block.item.answer = Some(cap(v));
                    block.answer_lines.push(i);
                }
                Some(("已送", v)) => {
                    block.item.sent = Some(cap(v));
                    block.answer_lines.push(i);
                }
                _ => {
                    if block.item.detail.len() < 8 {
                        block.item.detail.push(cap(c));
                    }
                }
            }
            continue;
        }
        finish(&mut open, &mut seen, &mut out);
        let Some(question) = bullet_text(t).map(cap).filter(|q| !q.is_empty()) else {
            continue;
        };
        open = Some(Block {
            item: HelpItemDto {
                id: String::new(),
                question,
                detail: Vec::new(),
                recommend: None,
                options: Vec::new(),
                fallback: None,
                category: "一般".into(),
                refs: None,
                answer: None,
                sent: None,
            },
            last_line: i,
            answer_lines: Vec::new(),
        });
    }
    finish(&mut open, &mut seen, &mut out);
    out
}

pub(crate) fn parse_items(text: &str) -> Vec<HelpItemDto> {
    parse_blocks(text).into_iter().map(|b| b.item).collect()
}

struct Source {
    root: String,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    repo_name: String,
    repo_path: String,
}

/// 主仓根的 help-wanted.md 被 git 跟踪、且和上次提交一字不差：是早先步骤把它提交进工作区、采纳时合并上来的旧副本
///（新项目 .gitignore 里已排除，老项目还在跟踪），不是根目录对话新写的问题，不列（2026-11-03 用户截图）。
/// 根目录对话后来又往里写了问题，文件就和提交不一样了，照常列
fn stale_merged_copy(root: &str) -> bool {
    let dir = Path::new(root);
    if crate::workspaces::run_git(dir, &["ls-files", "--error-unmatch", HELP_WANTED_FILE], std::time::Duration::from_secs(10)).is_err() {
        return false;
    }
    crate::workspaces::run_git(dir, &["diff", "--quiet", "HEAD", "--", HELP_WANTED_FILE], std::time::Duration::from_secs(10)).is_ok()
}

/// 工作区里那份是不是老历史：全是没有选项的自由写法，且已提交、没再改
fn legacy_history(root: &str, items: &[HelpItemDto]) -> bool {
    items.iter().all(|i| i.options.is_empty() && i.recommend.is_none()) && stale_merged_copy(root)
}

fn sources() -> Vec<Source> {
    let Ok(conn) = crate::workspaces::db() else { return Vec::new() };
    let Ok(rows) = crate::workspaces::query_workspaces(&conn) else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    // 已保存的步骤不再是 active，但 help-wanted 里的补全文、授权还要人做。
    for w in rows.into_iter().filter(|w| w.status != "archived") {
        // 工作树 + 主仓根各算一个来源（主仓可能覆盖多个工作区，去重）
        for (root, ws_id, ws_name) in [
            (w.worktree_path.clone(), Some(w.id.clone()), Some(w.name.clone())),
            (w.repo_path.clone(), None, None),
        ] {
            if !seen.insert(crate::paths::path_key(&root)) {
                continue;
            }
            if ws_id.is_none() && stale_merged_copy(&root) {
                continue;
            }
            out.push(Source {
                root,
                workspace_id: ws_id,
                workspace_name: ws_name,
                repo_name: w.repo_name.clone(),
                repo_path: w.repo_path.clone(),
            });
        }
    }
    out
}

/// 文件是 Agent 写的，出站前脱敏（id 按原文算，写回答时才对得上）
fn redact_item(mut item: HelpItemDto, secrets: &[String]) -> HelpItemDto {
    let r = |t: &str| crate::sessions::redact_sensitive_text_with(t, secrets);
    item.question = r(&item.question);
    item.detail = item.detail.iter().map(|d| r(d)).collect();
    for o in &mut item.options {
        o.label = r(&o.label);
        o.effect = o.effect.as_deref().map(r);
    }
    item.fallback = item.fallback.as_deref().map(r);
    item.refs = item.refs.as_deref().map(r);
    item.answer = item.answer.as_deref().map(r);
    item
}

#[tauri::command]
pub async fn list_help_requests() -> Vec<HelpRequestDto> {
    tauri::async_runtime::spawn_blocking(|| {
        let secrets = crate::profiles::stored_secrets();
        sources()
            .into_iter()
            .filter_map(|s| {
                let text = fs::read_to_string(Path::new(&s.root).join(HELP_WANTED_FILE)).ok()?;
                let items: Vec<_> =
                    parse_items(&text).into_iter().map(|i| redact_item(i, &secrets)).collect();
                // 步骤工作区里那份：已提交、没再改、全是 11-02 之前的自由写法（没有 A–D 选项）——是老项目从主仓带过来或早就答完的历史，
                // 不再列（2026-11-03 用户真实项目核对：综述流程测试 5 个工作区各挂 18–21 条九月的旧问题）。新格式的问题照常列，提交了也列
                if s.workspace_id.is_some() && legacy_history(&s.root, &items) {
                    return None;
                }
                (!items.is_empty()).then_some(HelpRequestDto {
                    root: s.root,
                    workspace_id: s.workspace_id,
                    workspace_name: s.workspace_name,
                    repo_name: s.repo_name,
                    repo_path: s.repo_path,
                    items,
                })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 读-改-写人工请求文件（同一把文件锁；锁只管得住 Mesa 自己，Agent 写文件不拿这把锁：写回前再读一遍，
/// 期间被 Agent 改过就不覆盖、报错让人再点一次，免得把 Agent 刚追加的问题盖掉——2026-11-03 自查）
fn edit_file(root: &Path, edit: impl FnOnce(&str, &[Block]) -> Result<Vec<(usize, Option<String>)>, String>) -> Result<(), String> {
    // 锁放在 Mesa 配置目录：放进项目 .ccode/ 会成为未跟踪文件，被 Agent 顺手提交
    let key = format!("{:x}", Sha256::digest(crate::paths::path_key(&root.to_string_lossy()).as_bytes()));
    let _lock = crate::storage::config_lock(&format!("help-wanted-{}", &key[..16]))?;
    let path = root.join(HELP_WANTED_FILE);
    let text = fs::read_to_string(&path).map_err(|e| format!("读不到人工请求文件：{e}"))?;
    let blocks = parse_blocks(&text);
    let changes = edit(&text, &blocks)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<Option<String>> = text.lines().map(|l| Some(l.to_string())).collect();
    // (行号, None) 删掉该行；(行号, Some(行)) 在该行之后插入
    let mut inserts: std::collections::BTreeMap<usize, Vec<String>> = Default::default();
    for (at, line) in changes {
        match line {
            None => {
                if let Some(slot) = lines.get_mut(at) {
                    *slot = None;
                }
            }
            Some(line) => inserts.entry(at).or_default().push(line),
        }
    }
    let mut out = Vec::new();
    for (i, line) in lines.into_iter().enumerate() {
        if let Some(line) = line {
            out.push(line);
        }
        if let Some(extra) = inserts.remove(&i) {
            out.extend(extra);
        }
    }
    let mut joined = out.join(newline);
    if text.ends_with('\n') {
        joined.push_str(newline);
    }
    if fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        return Err("人工请求文件刚被 Agent 改过，没写进去；再点一次".into());
    }
    crate::profiles::atomic_write(&path, &joined)
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(FIELD_CAP).collect()
}

fn known_source(root: &str) -> Result<Source, String> {
    sources()
        .into_iter()
        .find(|s| crate::paths::same_path(&s.root, root))
        .ok_or_else(|| "不是登记过的工作区或项目，拒绝写入人工请求".to_string())
}

pub(crate) fn answer_at(root: &Path, item_id: &str, answer: &str) -> Result<HelpItemDto, String> {
    let answer = one_line(answer);
    if answer.is_empty() {
        return Err("回答不能为空".into());
    }
    let mut found = None;
    edit_file(root, |_, blocks| {
        let block = blocks
            .iter()
            .find(|b| b.item.id == item_id)
            .ok_or("这条问题已经变了或被 Agent 处理掉了，刷新后再看")?;
        if block.item.sent.is_some() {
            return Err("这条已经交给 Agent 了，回答不能再改；要改直接在对话里说".into());
        }
        found = Some(block.item.clone());
        let mut changes: Vec<(usize, Option<String>)> =
            block.answer_lines.iter().map(|&i| (i, None)).collect();
        changes.push((block.last_line, Some(format!("  已答：{answer}"))));
        Ok(changes)
    })?;
    let mut item = found.expect("edit 成功即找到");
    item.answer = Some(answer);
    Ok(item)
}

pub(crate) fn mark_sent_at(root: &Path, when: &str) -> Result<usize, String> {
    let mut count = 0;
    edit_file(root, |_, blocks| {
        let changes: Vec<_> = blocks
            .iter()
            .filter(|b| b.item.answer.is_some() && b.item.sent.is_none())
            .map(|b| (b.last_line, Some(format!("  已送：{when}"))))
            .collect();
        count = changes.len();
        Ok(changes)
    })?;
    Ok(count)
}

/// 人在卡片上答一条。`remember` = "已定" / "不做"：同时记进项目知识，下一步任务书带上
#[tauri::command]
pub async fn help_request_answer(
    root: String,
    item_id: String,
    answer: String,
    remember: Option<String>,
) -> Result<HelpItemDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = known_source(&root)?;
        let project = match remember.as_deref() {
            Some(_) => Some(crate::projects::ensure_task_project_root(Path::new(&source.repo_path))?),
            None => None,
        };
        let item = answer_at(Path::new(&source.root), &item_id, &answer)?;
        let secrets = crate::profiles::stored_secrets();
        if let (Some(kind), Some(project)) = (remember.as_deref(), project) {
            // 问题是 Agent 写的：进项目知识前和出站同一口径脱敏（项目知识原样回到界面、进任务书）
            let r = |t: &str| crate::sessions::redact_sensitive_text_with(t, &secrets);
            crate::project_memory::record_human_decision(&project, kind, &r(&item.question), &r(item.answer.as_deref().unwrap_or_default()))
                .map_err(|e| format!("回答已记下，但没写进项目知识：{e}"))?;
        }
        Ok(redact_item(item, &secrets))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 交给 Agent 之前把已答未送的条目标上「已送」，收件箱不再提醒；返回标了几条
#[tauri::command]
pub async fn help_request_mark_sent(root: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = known_source(&root)?;
        let when = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        mark_sent_at(Path::new(&source.root), &when)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_bullets_still_parse_and_records_are_skipped() {
        let text = "# 需要人决定的事\n\n## 收尾\n\n- 7 篇 SI 未下载（兜底：只用正文数字）\n1. Zotero 进库待人操作\n\n## 0. 已由人拍板\n\n- **规模**：人答 20 篇\n\n## 1. 粗检依据（已拍板，保留备查）\n\n| # | 限定 | 命中数 |\n|---|---|---|\n| ① | 裸查 | 46,048 |\n\n复现：python scripts/x.py\n\n## 2. 待你拍板\n\n2、硼化物批身份最迟大纲前定\n";
        let qs: Vec<String> = parse_items(text).into_iter().map(|i| i.question).collect();
        assert_eq!(qs, ["7 篇 SI 未下载（兜底：只用正文数字）", "Zotero 进库待人操作", "硼化物批身份最迟大纲前定"]);
        assert!(parse_items("# 只有标题\n\n").is_empty());
    }

    #[test]
    fn structured_fields_parse() {
        let text = "- 纳入标准是否包含会议论文？\n  建议：B\n  A：只要期刊 —— 候选降到约 140 篇\n  B：期刊 + 顶会——保留 9 个会议\n  E：多余的不算\n  不回时：按 B 做可逆准备\n  类别：范围\n  依据：papers/screening.md 第 3 节\n  会议名单见附表\n- 下一条\n  建议：C\n";
        let items = parse_items(text);
        assert_eq!(items.len(), 2);
        let a = &items[0];
        assert_eq!(a.recommend.as_deref(), Some("B"));
        assert_eq!(a.options.len(), 2);
        assert_eq!(a.options[0].label, "只要期刊");
        assert_eq!(a.options[0].effect.as_deref(), Some("候选降到约 140 篇"));
        assert_eq!(a.options[1].label, "期刊 + 顶会");
        assert_eq!(a.fallback.as_deref(), Some("按 B 做可逆准备"));
        assert_eq!(a.category, "范围");
        assert_eq!(a.refs.as_deref(), Some("papers/screening.md 第 3 节"));
        assert_eq!(a.detail, ["E：多余的不算", "会议名单见附表"]);
        // 建议指向不存在的选项当没写
        assert_eq!(items[1].recommend, None);
        assert_eq!(items[1].category, "一般");
    }

    #[test]
    fn paragraph_ends_item_and_same_question_gets_distinct_ids() {
        let items = parse_items("- 同一问\n普通段落\n  缩进但无条目\n- 同一问\n");
        assert_eq!(items.len(), 2);
        assert!(items[0].detail.is_empty());
        assert_ne!(items[0].id, items[1].id);
    }

    #[test]
    fn answer_then_mark_sent_round_trip() {
        let dir = std::env::temp_dir().join(format!("mesa-help-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".ccode")).unwrap();
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let file = dir.join(HELP_WANTED_FILE);
        fs::write(&file, "# 待你定\r\n\r\n- 用哪个口径？\r\n  A：甲\r\n  B：乙\r\n- 第二问\r\n").unwrap();
        let id = parse_items(&fs::read_to_string(&file).unwrap())[0].id.clone();
        answer_at(&dir, &id, "A（甲）").unwrap();
        // 改答：旧「已答」被替换，不叠两行
        let item = answer_at(&dir, &id, "B\n（乙）").unwrap();
        assert_eq!(item.answer.as_deref(), Some("B （乙）"));
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches("已答").count(), 1, "{text}");
        assert!(text.contains("  B：乙\r\n  已答：B （乙）\r\n- 第二问\r\n"), "{text:?}");
        assert_eq!(mark_sent_at(&dir, "2026-11-02 10:00").unwrap(), 1);
        let items = parse_items(&fs::read_to_string(&file).unwrap());
        assert_eq!(items[0].sent.as_deref(), Some("2026-11-02 10:00"));
        assert!(items[1].answer.is_none());
        // 已送的不能再改；找不到的报错不覆盖
        assert!(answer_at(&dir, &id, "A").unwrap_err().contains("已经交给 Agent"));
        assert!(answer_at(&dir, "nope", "A").is_err());
        assert_eq!(mark_sent_at(&dir, "x").unwrap(), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn closed_and_record_sections_skipped_and_stale_root_copy_detected() {
        let text = "# 帮助请求\n\n## 一、两轮门口径——已闭环\n\n- 已经定了的事\n\n## 二、记录事项（不需回复）\n\n- 只是告诉你一声\n\n## 三、待你拍板\n\n- 真要问的\n";
        let qs: Vec<String> = parse_items(text).into_iter().map(|i| i.question).collect();
        assert_eq!(qs, ["真要问的"]);
        // 被 git 跟踪且和提交一样 = 合并上来的旧副本；改过（根目录对话又写了问题）就不算旧
        let root = std::env::temp_dir().join(format!("mesa-help-stale-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        let g = |args: &[&str]| crate::workspaces::run_git(&root, args, std::time::Duration::from_secs(15)).unwrap();
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        fs::write(root.join(HELP_WANTED_FILE), "- 旧问题\n").unwrap();
        let r = root.to_string_lossy().into_owned();
        assert!(!stale_merged_copy(&r), "没被跟踪的不算旧副本");
        g(&["add", "-A"]);
        g(&["commit", "-qm", "x"]);
        assert!(stale_merged_copy(&r));
        fs::write(root.join(HELP_WANTED_FILE), "- 旧问题\n- 新问题\n").unwrap();
        assert!(!stale_merged_copy(&r));
        // 工作区里那份：已提交的旧写法算历史；已提交的新格式（带选项）照常列
        g(&["commit", "-qam", "y"]);
        let legacy = parse_items("- 旧问题\n- 新问题\n");
        assert!(legacy_history(&r, &legacy));
        let structured = "- 年份下限？\n  建议：A\n  A：2021 起 —— 少\n  B：不限 —— 多\n";
        fs::write(root.join(HELP_WANTED_FILE), structured).unwrap();
        g(&["commit", "-qam", "z"]);
        let items = parse_items(structured);
        assert!(!items.is_empty() && !items[0].options.is_empty(), "{items:?}");
        assert!(!legacy_history(&r, &items));
        fs::remove_dir_all(&root).ok();
    }
}
