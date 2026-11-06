use super::*;


#[test]
fn optimize_prompt_carries_sources_direction_and_provides_rule() {
    let prompt = build_optimize_prompt(
        &[("lit-search".into(), "内置检索技能正文".into()), ("my-search".into(), "用户技能正文".into())],
        "把我的检索习惯融进去，保留严格档",
    );
    assert!(prompt.contains("### 源 1：lit-search"));
    assert!(prompt.contains("### 源 2：my-search"));
    assert!(prompt.contains("把我的检索习惯融进去，保留严格档"));
    assert!(prompt.contains("优先级最高"));
    assert!(prompt.contains("provides: [位名]"));
    assert!(prompt.contains("不得输出多份"));
}

#[test]
fn optimize_budget_total_cap_single_floor() {
    assert_eq!(optimize_source_budget(0), 0);
    assert_eq!(optimize_source_budget(1), 48 * 1024);
    assert_eq!(optimize_source_budget(6), 8 * 1024);
    // 源极多时保底优先（总量允许超 48KB）
    assert_eq!(optimize_source_budget(10), 8 * 1024);
}

#[test]
fn full_md_provides_only_survives_create() {
    let fx = Fx::new();
    let md = "---\nname: merged-skill\ndescription: 综合自 lit-search\nprovides: [lit-search]\n---\n\n正文\n".replace("\\n", "\n");
    let skill = create_skill_from_full_md_at(&fx.store, &md, "fallback", None, None).unwrap();
    assert_eq!(skill.name, "merged-skill");
    assert!(skill.derived_from.is_none());
    // 落盘文件里 provides 必须在（此前门槛漏掉 provides-only 稿）
    let written = fs::read_to_string(fx.store.skill_dir("merged-skill").join("SKILL.md")).unwrap();
    assert!(written.contains("provides:"));
    let parsed = parse_skill_md_text(&written);
    assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
}

#[test]
fn rewrite_frontmatter_name_authoritative() {
    // 常规稿：frontmatter 有 name 行 → 权威名替换
    let md = "---\nname: ai-name\ndescription: d\nprovides: [lit-search]\n---\n\n正文\n".replace("\\n", "\n");
    let out = rewrite_frontmatter_name(&md, "my-name");
    assert!(out.contains("name: my-name"));
    assert!(!out.contains("ai-name"));
    assert!(out.contains("provides: [lit-search]"));
    // 无 name 行：插入；未闭合 frontmatter：原样返回兜底
    let no_name = "---\ndescription: d\n---\n\n正文\n".replace("\\n", "\n");
    assert!(rewrite_frontmatter_name(&no_name, "x").contains("name: x"));
    let unclosed = "---\nname: ai\n正文".replace("\\n", "\n");
    assert_eq!(rewrite_frontmatter_name(&unclosed, "x"), unclosed);
}

#[test]
fn create_user_skill_name_authoritative_end_to_end() {
    let fx = Fx::new();
    // AI 稿名 ai-name，用户确认时改名 my-name → 落库名必须是 my-name（此前被 frontmatter 名静默压掉）
    let md = "---\nname: ai-name\ndescription: 合成\nprovides: [lit-notes]\n---\n\n正文\n".replace("\\n", "\n");
    let rewritten = rewrite_frontmatter_name(&md, "my-name");
    let skill = create_skill_from_full_md_at(&fx.store, &rewritten, "my-name", None, None).unwrap();
    assert_eq!(skill.name, "my-name");
    let written = fs::read_to_string(fx.store.skill_dir("my-name").join("SKILL.md")).unwrap();
    assert!(written.contains("name: my-name"));
}

#[test]
fn derived_from_roundtrip_stored_in_registry() {
    let fx = Fx::new();
    fx.add_lib_skill("plain-skill", "普通技能");
    let md = "---\nname: merged-2\ndescription: 合成\nprovides: [lit-notes]\n---\n\n正文\n".replace("\\n", "\n");
    let derived = vec![SkillDerivedFrom { name: "lit-notes".into(), digest: None }];
    create_skill_from_full_md_at(&fx.store, &md, "fallback", None, Some(derived)).unwrap();
    let stored = fx.store.read();
    let s = stored.iter().find(|s| s.name == "merged-2").unwrap();
    assert_eq!(
        s.derived_from.as_deref(),
        Some(&[SkillDerivedFrom { name: "lit-notes".into(), digest: None }][..])
    );
    // 旧档兼容：没有 derived_from 键的记录读回 None
    let plain = stored.iter().find(|s| s.name == "plain-skill").unwrap();
    assert!(plain.derived_from.is_none());
}

#[test]
fn frontmatter_provides_parsed_and_listed() {
    let fx = Fx::new();
    fx.add_lib_skill("plain-skill", "不声明 provides 的技能");
    let dir = fx.store.skill_dir("slot-skill");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: slot-skill\ndescription: 顶位技能\nprovides: [lit-search, lit-notes]\noutputs: [papers/x.md]\n---\nbody\n",
    )
    .unwrap();
    let mut skills = fx.store.read();
    skills.push(new_skill("slot-skill".into(), Some("顶位技能".into()), "local", None));
    fx.store.write(&skills).unwrap();
    let listed = list_skills_impl(&fx.store, &HashMap::new());
    let s = listed.iter().find(|s| s.name == "slot-skill").unwrap();
    assert_eq!(s.provides, vec!["lit-search".to_string(), "lit-notes".to_string()]);
    let plain = listed.iter().find(|s| s.name == "plain-skill").unwrap();
    assert!(plain.provides.is_empty());
}

#[test]
fn named_skill_snapshot_requires_matching_runtime_copy() {
    let fx = Fx::new();
    fx.add_lib_skill("science", "科学检查");
    assert!(
        snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex").is_err()
    );
    let runtime = fx.agents.get("codex").unwrap().join("science");
    fs::create_dir_all(&runtime).unwrap();
    fs::copy(
        fx.store.skill_dir("science").join("SKILL.md"),
        runtime.join("SKILL.md"),
    )
    .unwrap();
    let snapshot =
        snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex").unwrap();
    assert_eq!(
        snapshot[0].runtime_digest.as_deref(),
        Some(snapshot[0].library_digest.as_str())
    );
    assert!(snapshot[0].entry_text.contains("科学检查"));
    fs::write(runtime.join("SKILL.md"), "outdated").unwrap();
    assert!(
        snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex")
            .unwrap_err()
            .contains("漂移")
    );
}

struct Fx {
    dir: PathBuf,
    store: SkillStore,
    agents: HashMap<String, PathBuf>,
}

#[test]
fn builtin_update_ignores_crlf_vs_lf() {
    assert!(bytes_eq_ignore_crlf(b"a\r\nb\r\n", b"a\nb\n"));
    assert!(bytes_eq_ignore_crlf(b"a\nb\n", b"a\nb\n"));
    assert!(!bytes_eq_ignore_crlf(b"a\nb\n", b"a\nc\n"));
}

impl Fx {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = SkillStore {
            json_path: dir.join("skills.json"),
            lib: dir.join("skills"),
        };
        fs::create_dir_all(&store.lib).unwrap();
        let mut agents = HashMap::new();
        for spec in crate::agent_specs::all_agent_specs() {
            agents.insert(spec.id.to_string(), dir.join("agents").join(spec.id));
        }
        Self { dir, store, agents }
    }

    fn add_lib_skill(&self, name: &str, description: &str) -> SkillDto {
        let dir = self.store.skill_dir(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nbody\n"),
        )
        .unwrap();
        let skill = new_skill(
            name.to_string(),
            Some(description.to_string()),
            "local",
            None,
        );
        let mut skills = self.store.read();
        skills.push(skill.clone());
        self.store.write(&skills).unwrap();
        skill
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn github_repo_category_takes_repo_segment() {
    assert_eq!(
        github_repo_category("anthropics/skills"),
        Some("skills".to_string())
    );
    assert_eq!(github_repo_category("owner/"), None);
}

#[test]
fn list_skills_carries_content_digest_that_tracks_content() {
    let fx = Fx::new();
    fx.add_lib_skill("digest-demo", "版本记录");
    let listed = list_skills_impl(&fx.store, &fx.agents);
    let digest = listed[0].content_digest.clone().expect("list 应带内容摘要");
    assert!(!digest.is_empty());
    // 内容不变摘要不变；改了 SKILL.md 摘要必须变（快照按它认版本）
    let again = list_skills_impl(&fx.store, &fx.agents);
    assert_eq!(again[0].content_digest.as_deref(), Some(digest.as_str()));
    fs::write(
        fx.store.skill_dir("digest-demo").join("SKILL.md"),
        "---\nname: digest-demo\ndescription: v2\n---\nnew body\n",
    )
    .unwrap();
    let after = list_skills_impl(&fx.store, &fx.agents);
    assert_ne!(after[0].content_digest.as_deref(), Some(digest.as_str()));
}

#[test]
fn list_backfills_missing_agent_keys_for_legacy_skills() {
    // 老技能的 apps 表是创建时的注册表快照（后来接入的 agent 缺键）：
    // list 时现算补齐为 false，否则前端「一键应用」按 apps 键过滤会永远跳过新 agent
    let fx = Fx::new();
    let mut skill = fx.add_lib_skill("legacy", "老技能");
    skill.apps = HashMap::from([
        ("claude-code".to_string(), true),
        ("kimi".to_string(), false),
    ]);
    fx.store.write(&[skill]).unwrap();
    let listed = list_skills_impl(&fx.store, &fx.agents);
    assert_eq!(listed.len(), 1);
    let apps = &listed[0].apps;
    for spec in crate::agent_specs::all_agent_specs() {
        assert!(apps.contains_key(spec.id), "list 后 apps 缺 {}", spec.id);
    }
    // 既有键的值不被覆盖（true 保留、显式 false 保留）
    assert_eq!(apps["claude-code"], true);
    assert_eq!(apps["kimi"], false);
    // 现算不写盘：盘上仍是旧快照
    let on_disk = fx.store.read();
    assert_eq!(on_disk[0].apps.len(), 2);
}

#[test]
fn mentions_mcp_detects_keyword_and_tolerates_missing_file() {
    let fx = Fx::new();
    fx.add_lib_skill("plain", "普通技能");
    assert!(!mentions_mcp(&fx.store.skill_dir("plain").join("SKILL.md")));
    // 「推荐 MCP」段命中
    fx.add_lib_skill("with-mcp", "带 MCP 推荐");
    fs::write(
        fx.store.skill_dir("with-mcp").join("SKILL.md"),
        "---\nname: with-mcp\n---\n## 推荐 MCP\n配一个 arxiv 检索 server。\n",
    )
    .unwrap();
    assert!(mentions_mcp(
        &fx.store.skill_dir("with-mcp").join("SKILL.md")
    ));
    // 正文任意处出现 MCP 子串也命中；SKILL.md 缺失/不可读 → false 不报错
    assert!(!mentions_mcp(&fx.dir.join("missing").join("SKILL.md")));
}

#[test]
fn builtin_skill_files_are_well_formed() {
    // 内置 SKILL.md 必须能被解析口径读出 name/description，且 name 与目录名一致；
    // outputs 声明（行内列表）是产物冲突检测的数据源，内置技能必须带
    for (name, content) in BUILTIN_SKILLS {
        // include_str! 嵌入的是工作区字节：Windows 检出（core.autocrlf）是 CRLF，先归一
        let content = content.replace("\r\n", "\n");
        assert!(
            content.starts_with(&format!("---\nname: {name}\n")),
            "{name} 的 frontmatter name 与目录名不一致"
        );
        let fm: Vec<&str> = content
            .lines()
            .skip(1) // 首行 ---
            .take_while(|l| l.trim_end() != "---")
            .collect();
        let has_desc = fm
            .iter()
            .any(|l| l.starts_with("description: ") && l.len() > 14);
        assert!(has_desc, "{name} 缺少 description");
        let has_outputs = fm
            .iter()
            .any(|l| l.starts_with("outputs: [") && l.len() > 11);
        assert!(has_outputs, "{name} 未声明 outputs");
    }
}

#[test]
fn every_bundled_skill_file_is_embedded() {
    // 2026-10-24 实证：figure_permissions.py 进了仓库、SKILL.md 也写了要跑它，但没登记进
    // BUILTIN_SUPPORT，用户装到的技能里就没有这个脚本，定稿步一跑就找不到
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
    let mut missing = Vec::new();
    for (name, _) in BUILTIN_SKILLS {
        let dir = root.join(name);
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            for entry in fs::read_dir(&d).unwrap().flatten() {
                let path = entry.path();
                let file = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    if file != "__pycache__" {
                        stack.push(path);
                    }
                    continue;
                }
                if file == "SKILL.md" || file.ends_with(".pyc") || file.contains(".bak") {
                    continue;
                }
                let rel = path.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/");
                if !BUILTIN_SUPPORT.iter().any(|(s, r, _)| s == name && *r == rel) {
                    missing.push(format!("{name}/{rel}"));
                }
            }
        }
    }
    assert!(missing.is_empty(), "随包技能文件没登记进 BUILTIN_SUPPORT：{missing:?}");
}

#[test]
fn seed_adds_all_builtin_skills_once() {
    let fx = Fx::new();
    let added = seed_builtin_skills_impl(&fx.store).unwrap();
    assert_eq!(added.len(), BUILTIN_SKILLS.len());
    let skills = fx.store.read();
    for (name, _) in BUILTIN_SKILLS {
        assert!(fx.store.skill_dir(name).join("SKILL.md").is_file());
        let s = skills.iter().find(|s| s.name == *name).unwrap();
        assert_eq!(s.source, "builtin");
        assert!(!s.description.is_empty());
    }
    // 幂等：第二次不再新增
    assert!(seed_builtin_skills_impl(&fx.store).unwrap().is_empty());
}

#[test]
fn builtin_skills_default_to_mesa_group_user_override_wins() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    fx.add_lib_skill("my-local-skill", "本地导入的技能");
    // 2026-10-16 起存量库早期以 local 进库的内置技能已一次性翻回 builtin 标签：
    // 归组只认 source=builtin，local 同名（用户自有版本）不再归「Mesa 内置」
    {
        let mut skills = fx.store.read();
        let old = skills
            .iter_mut()
            .find(|s| s.source == "builtin" && s.name != "zotero-sync")
            .unwrap();
        old.source = "local".to_string();
        // 用户给一个内置技能设了自定义分组：写进库里
        skills
            .iter_mut()
            .find(|s| s.name == "zotero-sync")
            .unwrap()
            .category = Some("我的文献组".to_string());
        fx.store.write(&skills).unwrap();
    }
    let listed = list_skills_impl(&fx.store, &HashMap::new());
    let mesa = listed
        .iter()
        .filter(|s| s.category.as_deref() == Some("Mesa 内置"))
        .count();
    // 21 个内置：19 个默认归组 + zotero-sync 用户自定义 + 被改成 local（用户自有）不归组 = 19
    assert_eq!(mesa, BUILTIN_SKILLS.len() - 2, "除用户自定义与 local 同名（用户自有），其余内置归组");
    assert_eq!(
        listed.iter().filter(|s| s.category.as_deref() == Some("我的文献组")).count(),
        1
    );
    // 非内置技能不动：仍是无分组
    let local = listed.iter().find(|s| s.name == "my-local-skill").unwrap();
    assert!(local.category.is_none());
    // 不写盘：库里的原始记录仍为空分组
    let stored = fx.store.read();
    assert!(stored
        .iter()
        .filter(|s| s.source == "builtin" && s.category.is_none())
        .count() > 0);
}

#[test]
fn seed_never_overwrites_existing_user_skill() {
    let fx = Fx::new();
    let first = BUILTIN_SKILLS[0].0;
    fx.add_lib_skill(first, "用户自己的描述");
    let md = fx.store.skill_dir(first).join("SKILL.md");
    let before = fs::read_to_string(&md).unwrap();
    let added = seed_builtin_skills_impl(&fx.store).unwrap();
    assert!(!added.contains(&first.to_string()));
    assert_eq!(fs::read_to_string(&md).unwrap(), before);
    let skills = fx.store.read();
    assert_eq!(
        skills.iter().find(|s| s.name == first).unwrap().source,
        "local"
    );
}

#[test]
fn seed_marker_prevents_resurrecting_deleted_builtin() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    // 用户删掉一个内置技能：marker 已是最新版本，不应复活
    let first = BUILTIN_SKILLS[0].0;
    fs::remove_dir_all(fx.store.skill_dir(first)).unwrap();
    let mut skills = fx.store.read();
    skills.retain(|s| s.name != first);
    fx.store.write(&skills).unwrap();
    assert!(seed_builtin_skills_impl(&fx.store).unwrap().is_empty());
    assert!(!fx.store.skill_dir(first).exists());
}

#[test]
fn seed_version_bump_does_not_resurrect_deleted_builtin() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    // 走正式删除通道删掉一个内置技能 → 落墓碑
    let first = BUILTIN_SKILLS[0].0;
    let id = fx
        .store
        .read()
        .iter()
        .find(|s| s.name == first)
        .unwrap()
        .id
        .clone();
    let backups = fx.dir.join("skill-backups");
    delete_impl(&fx.store, &fx.agents, &backups, &id).unwrap();
    assert!(read_builtin_tombstones(&fx.store).contains(&first.to_string()));
    // 模拟种子版本升级（marker 拨回旧版）：补播不得复活已删技能
    fs::write(fx.store.lib.join(BUILTIN_SEED_MARKER), "0").unwrap();
    let added = seed_builtin_skills_impl(&fx.store).unwrap();
    assert!(!added.contains(&first.to_string()));
    assert!(!fx.store.skill_dir(first).exists());
    assert!(!fx.store.read().iter().any(|s| s.name == first));
}

#[test]
fn seed_backfills_tombstone_from_legacy_backup() {
    // 墓碑机制前的老版本删除：库里缺名但 skill-backups 留有同名备份 →
    // 升级补播时回填墓碑、不复活
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    let first = BUILTIN_SKILLS[0].0;
    fs::remove_dir_all(fx.store.skill_dir(first)).unwrap();
    let mut skills = fx.store.read();
    skills.retain(|s| s.name != first);
    fx.store.write(&skills).unwrap();
    let backups = fx.dir.join("skill-backups");
    fs::create_dir_all(backups.join(format!("{first}.20260101-000000"))).unwrap();
    fs::write(fx.store.lib.join(BUILTIN_SEED_MARKER), "0").unwrap();
    let added = seed_builtin_skills_impl(&fx.store).unwrap();
    assert!(!added.contains(&first.to_string()));
    assert!(read_builtin_tombstones(&fx.store).contains(&first.to_string()));
    assert!(!fx.store.skill_dir(first).exists());
}

#[test]
fn deleting_non_builtin_skill_leaves_no_tombstone() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("mine", "用户自建");
    let backups = fx.dir.join("skill-backups");
    delete_impl(&fx.store, &fx.agents, &backups, &skill.id).unwrap();
    assert!(read_builtin_tombstones(&fx.store).is_empty());
}

#[test]
fn builtin_support_scripts_seed_and_update_together_without_touching_user_files() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    let name = "endnote-bridge";
    let script = fx.store.skill_dir(name).join("scripts/bridge.py");
    assert!(fx.store.skill_dir("quarto-render").join("ieee.csl").is_file());
    assert!(script.is_file());
    fs::write(&script, "user changed script").unwrap();
    let other = fx.store.skill_dir(name).join("my-note.txt");
    fs::write(&other, "keep").unwrap();
    assert!(check_builtin_skill_updates_impl(&fx.store).contains(&name.to_string()));
    apply_builtin_skill_update_impl(&fx.store, name).unwrap();
    assert_eq!(
        fs::read_to_string(&script).unwrap(),
        builtin_files(name)
            .into_iter()
            .find(|(path, _)| *path == "scripts/bridge.py")
            .unwrap()
            .1
    );
    assert_eq!(fs::read_to_string(other).unwrap(), "keep");
    assert!(fs::read_dir(script.parent().unwrap())
        .unwrap()
        .flatten()
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("bridge.py.bak-")));
}

#[test]
fn builtin_update_check_and_apply() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    // 库里副本与种子一致 → 无提示
    assert!(check_builtin_skill_updates_impl(&fx.store).is_empty());
    // 库内是旧内容（含用户自改）→ 检出该技能
    let first = BUILTIN_SKILLS[0].0;
    let md = fx.store.skill_dir(first).join("SKILL.md");
    fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容\n").unwrap();
    // skills.json 描述也拨旧，验证更新后同步回种子描述
    let mut skills = fx.store.read();
    let pos = skills.iter().position(|s| s.name == first).unwrap();
    skills[pos].description = "旧描述".into();
    fx.store.write(&skills).unwrap();
    assert_eq!(
        check_builtin_skill_updates_impl(&fx.store),
        vec![first.to_string()]
    );
    // 库里缺目录的内置技能不提示（缺失归播种器管）
    let second = BUILTIN_SKILLS[1].0;
    fs::remove_dir_all(fx.store.skill_dir(second)).unwrap();
    assert!(!check_builtin_skill_updates_impl(&fx.store).contains(&second.to_string()));
    // 应用更新：内容 = 种子、备份存在且为旧内容、skills.json 描述同步
    apply_builtin_skill_update_impl(&fx.store, first).unwrap();
    let seed = BUILTIN_SKILLS.iter().find(|(n, _)| *n == first).unwrap().1;
    assert_eq!(fs::read_to_string(&md).unwrap(), seed);
    let backups_of = |fx: &Fx| -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(fx.store.skill_dir(first))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("SKILL.md.bak-"))
            .collect();
        v.sort();
        v
    };
    let backups = backups_of(&fx);
    assert_eq!(backups.len(), 1, "应恰好一份备份: {backups:?}");
    assert!(
        fs::read_to_string(fx.store.skill_dir(first).join(&backups[0]))
            .unwrap()
            .contains("旧内容"),
        "备份必须保留更新前内容"
    );
    let saved = fx.store.read();
    let s = saved.iter().find(|s| s.name == first).unwrap();
    let seed_desc = parse_skill_md(&md).description;
    assert_eq!(
        s.description,
        seed_desc.unwrap_or_default(),
        "描述同步为新版"
    );
    assert_ne!(s.description, "旧描述");
    // 追平后检测归零
    assert!(check_builtin_skill_updates_impl(&fx.store).is_empty());
    // 同日再次更新：备份追加 -2 后缀防覆盖
    fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容 v2\n").unwrap();
    apply_builtin_skill_update_impl(&fx.store, first).unwrap();
    let backups = backups_of(&fx);
    assert_eq!(backups.len(), 2, "同日重复更新应追加序号: {backups:?}");
    assert!(backups[1].ends_with("-2"), "{backups:?}");
    // 非内置技能名报错
    let err = apply_builtin_skill_update_impl(&fx.store, "not-builtin").unwrap_err();
    assert!(err.contains("不是内置技能"), "{err}");
}

#[test]
fn builtin_update_also_refreshes_distributed_copies() {
    let fx = Fx::new();
    seed_builtin_skills_impl(&fx.store).unwrap();
    let first = BUILTIN_SKILLS[0].0;
    let id = fx.store.read().into_iter().find(|s| s.name == first).unwrap().id;
    // codex 拿的是复制件；库里改旧后复制件跟着旧
    let md = fx.store.skill_dir(first).join("SKILL.md");
    fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容\n").unwrap();
    apply_impl(&fx.store, &fx.agents, &id, "codex", true, false).unwrap();
    let copy = fx.agents["codex"].join(first).join("SKILL.md");
    assert!(fs::read_to_string(&copy).unwrap().contains("旧内容"));
    // 采用新版：库和复制件一起追平，不再留「同步副本」
    let synced = apply_builtin_and_resync(&fx.store, &fx.agents, first).unwrap();
    assert_eq!(synced, vec!["codex".to_string()]);
    let seed = BUILTIN_SKILLS.iter().find(|(n, _)| *n == first).unwrap().1;
    assert_eq!(fs::read_to_string(&copy).unwrap(), seed);
    let skill = fx.store.read().into_iter().find(|s| s.id == id).unwrap();
    assert!(stale_agents(&fx.store, &fx.agents, &skill).is_empty());
}

#[test]
fn builtin_update_check_ignores_user_owned_same_name() {
    let fx = Fx::new();
    // 用户自建与内置同名的技能（source=local）：内容与种子不同，但不得提示。
    // 2026-10-16 存量库早期以 local 进库的 14 个内置技能已一次性翻回 builtin 标签，
    // local 同名重新稳定意味着用户自有版本，豁免成立。
    let first = BUILTIN_SKILLS[0].0;
    fx.add_lib_skill(first, "用户自己的版本");
    assert!(
        check_builtin_skill_updates_impl(&fx.store).is_empty(),
        "source 非 builtin 的同名技能不提示"
    );
}

#[test]
fn backfill_fills_only_uncategorized_github_skills() {
    let fx = Fx::new();
    let local = fx.add_lib_skill("pdf", "本地");
    let gh = fx.add_lib_skill("aihot", "x");
    let gh_named = fx.add_lib_skill("neat", "x");
    {
        let mut skills = fx.store.read();
        for s in &mut skills {
            if s.id == gh.id {
                s.source = "github".into();
                s.repo = Some("KKKKhazix/khazix-skills".into());
            }
            if s.id == gh_named.id {
                s.source = "github".into();
                s.repo = Some("o/r".into());
                s.category = Some("项目整理".into());
            }
        }
        fx.store.write(&skills).unwrap();
    }
    let filled = backfill_categories_impl(&fx.store).unwrap();
    assert_eq!(filled, 1);
    let after = fx.store.read();
    assert_eq!(
        after
            .iter()
            .find(|s| s.id == gh.id)
            .unwrap()
            .category
            .as_deref(),
        Some("khazix-skills")
    );
    assert_eq!(
        after
            .iter()
            .find(|s| s.id == gh_named.id)
            .unwrap()
            .category
            .as_deref(),
        Some("项目整理"),
        "已有分类不得被覆盖"
    );
    assert!(
        after
            .iter()
            .find(|s| s.id == local.id)
            .unwrap()
            .category
            .is_none(),
        "非 GitHub 来源不动"
    );
    // 幂等：再跑一遍没有可回填的
    assert_eq!(backfill_categories_impl(&fx.store).unwrap(), 0);
}

#[test]
fn skill_tags_trim_dedupe_and_limit() {
    // trim + 丢空 + 保序去重
    let tags = validate_skill_tags(&[
        " 文献 ".into(),
        "".into(),
        "   ".into(),
        "综述".into(),
        "文献".into(),
    ])
    .unwrap();
    assert_eq!(tags, vec!["文献".to_string(), "综述".to_string()]);
    // 空输入 = 清除全部
    assert_eq!(validate_skill_tags(&[]).unwrap(), Vec::<String>::new());
    // 超 4 个拒绝
    let five: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
    assert!(validate_skill_tags(&five).is_err());
    // 重复折叠后 ≤4 仍放行
    let dup: Vec<String> = ["a", "b", "c", "d", "a"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(validate_skill_tags(&dup).unwrap().len(), 4);
    // 单标签超 20 字符拒绝（按字符数，不按字节）
    assert!(validate_skill_tags(&["字".repeat(20)]).is_ok());
    assert!(validate_skill_tags(&["字".repeat(21)]).is_err());
}

#[test]
fn frontmatter_tolerates_bom_crlf_and_missing_fields() {
    let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("SKILL.md");
    fs::write(&f, "\u{feff}---\r\nname: pdf\r\ndescription: 处理 PDF 文件\r\nextra: ignored\r\n---\r\n# body\r\n").unwrap();
    let parsed = parse_skill_md(&f);
    assert_eq!(parsed.name.as_deref(), Some("pdf"));
    assert_eq!(parsed.description.as_deref(), Some("处理 PDF 文件"));
    fs::write(&f, "---\nname: only-name\n---\n").unwrap();
    assert_eq!(
        parse_skill_md(&f),
        SkillFrontmatter {
            name: Some("only-name".into()),
            ..Default::default()
        }
    );
    fs::write(&f, "# 没有 frontmatter\n").unwrap();
    assert_eq!(parse_skill_md(&f), SkillFrontmatter::default());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn list_skills_carries_outputs_from_frontmatter() {
    let fx = Fx::new();
    fx.add_lib_skill("with-outputs", "带产物声明");
    fs::write(
        fx.store.skill_dir("with-outputs").join("SKILL.md"),
        "---\nname: with-outputs\noutputs: [papers/, notes/inbox.md]\n---\nbody\n",
    )
    .unwrap();
    fx.add_lib_skill("no-outputs", "无产物声明");
    let skills = list_skills_impl(&fx.store, &HashMap::new());
    let s = skills.iter().find(|s| s.name == "with-outputs").unwrap();
    assert_eq!(
        s.outputs,
        vec!["papers/".to_string(), "notes/inbox.md".to_string()]
    );
    let s = skills.iter().find(|s| s.name == "no-outputs").unwrap();
    assert!(s.outputs.is_empty(), "未声明 outputs 的技能为空数组");
}

#[test]
fn frontmatter_outputs_inline_and_block_and_missing() {
    let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("SKILL.md");
    // 行内列表写法
    fs::write(
        &f,
        "---\nname: s\noutputs: [papers/, references.bib]\n---\n# body\n",
    )
    .unwrap();
    assert_eq!(
        parse_skill_md(&f).outputs,
        vec!["papers/".to_string(), "references.bib".to_string()]
    );
    // 多行列表写法（允许缩进与引号）
    fs::write(
        &f,
        "---\nname: s\noutputs:\n  - notes/\n  - \"notes/inbox.md\"\ndescription: d\n---\n",
    )
    .unwrap();
    let parsed = parse_skill_md(&f);
    assert_eq!(
        parsed.outputs,
        vec!["notes/".to_string(), "notes/inbox.md".to_string()]
    );
    assert_eq!(
        parsed.description.as_deref(),
        Some("d"),
        "列表结束后其他字段照常解析"
    );
    // inputs 同样支持多行列表写法
    fs::write(
        &f,
        "---\nname: s\ninputs:\n  - papers/included.md\n  - references.bib\n---\n",
    )
    .unwrap();
    assert_eq!(
        parse_skill_md(&f).inputs,
        vec![
            "papers/included.md".to_string(),
            "references.bib".to_string()
        ]
    );
    // 裸标量写法容忍为单条
    fs::write(&f, "---\nname: s\noutputs: outline.md\n---\n").unwrap();
    assert_eq!(parse_skill_md(&f).outputs, vec!["outline.md".to_string()]);
    // 缺字段 = 空数组
    fs::write(&f, "---\nname: s\ndescription: d\n---\n").unwrap();
    assert!(parse_skill_md(&f).outputs.is_empty());
    // 空行内列表 = 空数组
    fs::write(&f, "---\nname: s\noutputs: []\n---\n").unwrap();
    assert!(parse_skill_md(&f).outputs.is_empty());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn skill_md_body_splits_frontmatter_exactly() {
    assert_eq!(skill_md_body("---\nname: s\n---\n正文\n"), "正文\n");
    // CRLF 不错位
    assert_eq!(
        skill_md_body("---\r\nname: s\r\n---\r\n正文\r\n"),
        "正文\r\n"
    );
    // 无 frontmatter / 未闭合：按全文对待
    assert_eq!(skill_md_body("# 直接正文\n"), "# 直接正文\n");
    assert_eq!(
        skill_md_body("---\nname: s\n没闭合"),
        "---\nname: s\n没闭合"
    );
}

#[test]
fn infer_interface_classifies_paths_by_verb() {
    let (inputs, outputs) = infer_interface_from_body(
        "先读取 papers/included.md 与 references.bib，对照 notes/ 下的笔记。\n\
             筛选结果写入 papers/screening.md，并保存到 papers/included.md。\n\
             详细说明见 https://example.com/docs/x.md。\n\
             读取 papers/a.md 并写入 papers/b.md（双侧动词，不猜）。\n\
             参考文献用 bib 格式（无路径 token，不猜）。",
    );
    assert_eq!(
        inputs,
        vec![
            "papers/included.md".to_string(),
            "references.bib".to_string(),
            "notes/".to_string()
        ]
    );
    assert_eq!(
        outputs,
        vec![
            "papers/screening.md".to_string(),
            "papers/included.md".to_string()
        ]
    );
    // URL、双侧动词行、无路径行都不进结果
    assert!(!inputs
        .iter()
        .chain(outputs.iter())
        .any(|p| p.contains("http")));
    assert!(!inputs
        .iter()
        .chain(outputs.iter())
        .any(|p| p.contains("a.md")));
}

#[test]
fn infer_interface_tolerates_unspaced_cjk_and_caps() {
    // 无空格连写 + 反引号包裹都能认出；每侧最多 8 条防噪
    let (inputs, outputs) = infer_interface_from_body(
        "将结果写入papers/screening.md。\n把笔记追加到`notes/inbox.md`尾部。",
    );
    assert!(inputs.is_empty());
    assert_eq!(
        outputs,
        vec![
            "papers/screening.md".to_string(),
            "notes/inbox.md".to_string()
        ]
    );
}

#[test]
fn list_skills_infers_interface_when_frontmatter_silent() {
    let fx = Fx::new();
    fx.add_lib_skill("external", "外部技能");
    fs::write(
        fx.store.skill_dir("external").join("SKILL.md"),
        "---\nname: external\n---\n读取 references.bib 后开始。\n产出 outline.md 即完成。\n",
    )
    .unwrap();
    let skills = list_skills_impl(&fx.store, &HashMap::new());
    let s = skills.iter().find(|s| s.name == "external").unwrap();
    assert_eq!(s.inputs, vec!["references.bib".to_string()]);
    assert_eq!(s.outputs, vec!["outline.md".to_string()]);
    assert!(s.interface_inferred, "推断兜底必须打标");
    // frontmatter 有声明时不走推断、不打标
    fx.add_lib_skill("declared", "有声明");
    fs::write(
        fx.store.skill_dir("declared").join("SKILL.md"),
        "---\nname: declared\noutputs: [x.md]\n---\n读取 references.bib。\n",
    )
    .unwrap();
    let skills = list_skills_impl(&fx.store, &HashMap::new());
    let s = skills.iter().find(|s| s.name == "declared").unwrap();
    assert_eq!(s.outputs, vec!["x.md".to_string()]);
    assert!(s.inputs.is_empty());
    assert!(!s.interface_inferred);
}

#[test]
fn compose_skill_md_writes_interface_lists() {
    let text = compose_skill_md(
        "s",
        "描述",
        "正文",
        &["papers/".to_string()],
        &["notes/inbox.md".to_string()],
        &["lit-search".to_string()],
    );
    assert!(text.contains("inputs:\n  - papers/\n"));
    assert!(text.contains("outputs:\n  - notes/inbox.md\n"));
    assert!(text.contains("provides:\n  - lit-search\n"));
    // 往返一致：写出来的 frontmatter 能被解析回同样的接口（provides 同口径，编辑不丢声明）
    let parsed = parse_skill_md_text(&text);
    assert_eq!(parsed.inputs, vec!["papers/".to_string()]);
    assert_eq!(parsed.outputs, vec!["notes/inbox.md".to_string()]);
    assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
    // 空接口不写键（保持既有格式不变）
    let plain = compose_skill_md("s", "描述", "正文", &[], &[], &[]);
    assert!(!plain.contains("inputs:") && !plain.contains("outputs:") && !plain.contains("provides:"));
}

#[test]
fn strip_code_fence_unwraps_fenced_output() {
    assert_eq!(
        strip_code_fence("```markdown\n---\nname: s\n---\n正文\n```"),
        "---\nname: s\n---\n正文"
    );
    assert_eq!(
        strip_code_fence("---\nname: s\n---\n正文"),
        "---\nname: s\n---\n正文"
    );
}

#[test]
fn build_adapt_prompt_carries_conventions_and_skill() {
    let prompt = build_adapt_prompt("my-skill", "---\nname: my-skill\n---\n正文");
    assert!(prompt.contains("papers/"), "规范路径表必须在 prompt 里");
    assert!(prompt.contains("screening.md"));
    assert!(prompt.contains("references.bib"));
    assert!(prompt.contains("【当前 SKILL.md】\n---\nname: my-skill\n---\n正文"));
    assert!(prompt.contains("inputs:"), "必须要求补写接口声明");
}

#[test]
fn usable_adapt_draft_strips_preamble_and_drops_unknown_provides() {
    let raw = "下面是改好的稿：\n```markdown\n---\nname: hacked\ndescription: 新描述\ninputs:\n  - papers/included.md\noutputs:\n  - notes/\nprovides: [lit-search, not-a-slot]\n---\n新正文\n```\n";
    let draft = usable_adapt_draft(raw).unwrap();
    let parsed = parse_skill_md_text(&draft);
    assert_eq!(parsed.inputs, vec!["papers/included.md".to_string()]);
    assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
    assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
    assert_eq!(skill_md_body(&draft).trim(), "新正文");
    assert!(usable_adapt_draft("只有一段说明，没有 frontmatter").is_err());
}

#[test]
fn already_aligned_skill_is_detected() {
    let aligned = "---\nname: lit-search\noutputs:\n  - papers/screening.md\nprovides: [lit-search]\n---\n正文\n";
    assert!(already_pipeline_aligned(aligned));
    assert!(!already_pipeline_aligned("---\nname: x\n---\n随便写，没有路径\n"));
}

#[test]
fn write_skill_md_rewrites_interface_and_preserves_name() {
    let fx = Fx::new();
    fx.add_lib_skill("ext", "旧描述");
    let mut skills = fx.store.read();
    // 适配稿：name 字段被篡改也不生效（目录名不可改），description/inputs/outputs 取稿件
    let full = "---\nname: hacked\ndescription: 新描述\ninputs:\n  - papers/included.md\noutputs:\n  - notes/\n---\n新正文\n";
    let parsed = parse_skill_md_text(full);
    update_content_impl(
        &fx.store,
        &mut skills,
        "ext",
        skill_md_body(full),
        parsed.description,
        Some((parsed.inputs, parsed.outputs, parsed.provides)),
    )
    .unwrap();
    let written = fs::read_to_string(fx.store.skill_dir("ext").join("SKILL.md")).unwrap();
    let parsed = parse_skill_md_text(&written);
    assert!(written.contains("name: ext"), "name 强制沿用库中条目");
    assert!(!written.contains("hacked"));
    assert_eq!(parsed.description.as_deref(), Some("新描述"));
    assert_eq!(parsed.inputs, vec!["papers/included.md".to_string()]);
    assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
    assert_eq!(skill_md_body(&written).trim(), "新正文");
}

#[test]
fn update_content_preserves_declared_interface_by_default() {
    let fx = Fx::new();
    fx.add_lib_skill("ext", "带接口");
    fs::write(
        fx.store.skill_dir("ext").join("SKILL.md"),
        "---\nname: ext\ndescription: 带接口\ninputs: [papers/]\noutputs: [notes/]\n---\n旧正文\n",
    )
    .unwrap();
    let mut skills = fx.store.read();
    // 普通编辑（interface = None）：frontmatter 接口声明必须保留，不被静默丢弃
    update_content_impl(&fx.store, &mut skills, "ext", "新正文", None, None).unwrap();
    let written = fs::read_to_string(fx.store.skill_dir("ext").join("SKILL.md")).unwrap();
    let parsed = parse_skill_md_text(&written);
    assert_eq!(parsed.inputs, vec!["papers/".to_string()]);
    assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
    assert_eq!(skill_md_body(&written).trim(), "新正文");
}

#[test]
fn discovery_flattens_nested_and_skips_dot_dirs() {
    let fx = Fx::new();
    // 嵌套技能（找到不下钻）+ dot-dir 里的技能被跳过
    fs::create_dir_all(fx.dir.join("src/skills/doc/docx")).unwrap();
    fs::write(
        fx.dir.join("src/skills/doc/docx/SKILL.md"),
        "---\nname: docx\n---\n",
    )
    .unwrap();
    fs::create_dir_all(fx.dir.join("src/.hidden/secret")).unwrap();
    fs::write(
        fx.dir.join("src/.hidden/secret/SKILL.md"),
        "---\nname: secret\n---\n",
    )
    .unwrap();
    let mut found = Vec::new();
    find_skill_dirs(&fx.dir.join("src"), &mut found);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].file_name().unwrap(), "docx");
    let mut skills = Vec::new();
    let mut first = SkillImportResultDto::default();
    import_one_dir(
        &fx.store,
        &mut skills,
        &found[0],
        None,
        "local",
        None,
        None,
        &mut first,
    )
    .unwrap();
    assert_eq!(first.added, vec!["docx"]);
    assert_eq!(skills[0].name, "docx", "拍平为末段目录名");
    assert!(fx.store.skill_dir("docx").join("SKILL.md").exists());
    // 同名再导入必须返回结构化冲突，不能静默跳过
    let mut second = SkillImportResultDto::default();
    import_one_dir(
        &fx.store,
        &mut skills,
        &found[0],
        None,
        "local",
        None,
        None,
        &mut second,
    )
    .unwrap();
    assert_eq!(second.conflicts.len(), 1);
    assert_eq!(second.conflicts[0].name, "docx");
}

#[test]
fn import_conflict_can_overwrite_with_backup() {
    let fx = Fx::new();
    fx.add_lib_skill("pdf", "旧版本");
    let incoming = fx.dir.join("incoming/pdf");
    fs::create_dir_all(&incoming).unwrap();
    fs::write(
        incoming.join("SKILL.md"),
        "---\nname: pdf\ndescription: 新版本\n---\nnew body\n",
    )
    .unwrap();
    let mut skills = fx.store.read();
    let resolutions = HashMap::from([("pdf".to_string(), "overwrite".to_string())]);
    let mut result = SkillImportResultDto::default();
    import_one_dir(
        &fx.store,
        &mut skills,
        &incoming,
        None,
        "local",
        None,
        Some(&resolutions),
        &mut result,
    )
    .unwrap();
    assert_eq!(result.updated, vec!["pdf"]);
    assert_eq!(fx.store.read()[0].description, "新版本");
    assert!(
        fs::read_to_string(fx.store.skill_dir("pdf").join("SKILL.md"))
            .unwrap()
            .contains("new body")
    );
    let backup_root = fx.dir.join("skill-backups");
    let backup = fs::read_dir(&backup_root)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pdf.")
        })
        .expect("覆盖前必须留下备份");
    assert!(fs::read_to_string(backup.join("SKILL.md"))
        .unwrap()
        .contains("旧版本"));
}

#[test]
fn import_conflict_can_save_as_new_name() {
    let fx = Fx::new();
    fx.add_lib_skill("pdf", "旧版本");
    let incoming = fx.dir.join("incoming/pdf");
    fs::create_dir_all(&incoming).unwrap();
    fs::write(
        incoming.join("SKILL.md"),
        "---\nname: pdf\ndescription: 另一个版本\n---\n",
    )
    .unwrap();
    let mut skills = fx.store.read();
    let resolutions =
        HashMap::from([("pdf".to_string(), "rename:pdf-alternative".to_string())]);
    let mut result = SkillImportResultDto::default();
    import_one_dir(
        &fx.store,
        &mut skills,
        &incoming,
        None,
        "zip",
        None,
        Some(&resolutions),
        &mut result,
    )
    .unwrap();
    assert_eq!(result.added, vec!["pdf-alternative"]);
    assert_eq!(fx.store.read().len(), 2);
    assert!(fx.store.skill_dir("pdf").exists());
    assert!(fx.store.skill_dir("pdf-alternative").exists());
}

#[test]
fn create_registers_skill_and_rejects_duplicate() {
    let fx = Fx::new();
    let mut skills = fx.store.read();
    create_impl(
        &fx.store,
        &mut skills,
        "my-method",
        "我的方法",
        "第一步……\n第二步……",
    )
    .unwrap();
    let text = fs::read_to_string(fx.store.skill_dir("my-method").join("SKILL.md")).unwrap();
    assert!(text.contains("name: my-method"), "{text}");
    assert!(text.contains("description: 我的方法"), "{text}");
    assert!(text.contains("第一步……"), "{text}");
    let saved = fx.store.read();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].name, "my-method");
    assert_eq!(
        saved[0].description, "我的方法",
        "元数据描述从落盘 SKILL.md 解析"
    );
    assert_eq!(
        saved[0].source, "ccode",
        "新建技能标记为 Mesa 自建（删除保护来源分类）"
    );
    // 重名拒绝并提示改用编辑（不覆盖、不静默跳过）
    let mut again = fx.store.read();
    let err = create_impl(&fx.store, &mut again, "my-method", "x", "y").unwrap_err();
    assert!(err.contains("已存在"), "{err}");
    // 非法名称（多段路径）拒绝
    let err = create_impl(&fx.store, &mut Vec::new(), "a/b", "x", "y").unwrap_err();
    assert!(err.contains("单个安全目录名"), "{err}");
    assert!(!fx.store.skill_dir("a").exists(), "非法名称不得落盘");
}

#[test]
fn update_content_backs_up_and_preserves_aux_files() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "旧描述");
    // SKILL.md 之外的辅助文件（模板等）编辑后必须保留
    fs::write(fx.store.skill_dir("pdf").join("template.txt"), "模板内容").unwrap();
    let mut skills = fx.store.read();
    update_content_impl(
        &fx.store,
        &mut skills,
        "pdf",
        "新正文",
        Some("新描述".into()),
        None,
    )
    .unwrap();
    let dir = fx.store.skill_dir("pdf");
    assert!(fs::read_to_string(dir.join("SKILL.md"))
        .unwrap()
        .contains("新正文"));
    assert_eq!(
        fs::read_to_string(dir.join("template.txt")).unwrap(),
        "模板内容",
        "辅助文件必须保留"
    );
    let saved = fx.store.read();
    assert_eq!(saved[0].description, "新描述");
    assert_eq!(saved[0].id, skill.id, "编辑不换 id");
    assert_eq!(saved[0].source, "local", "编辑不改写来源信息");
    // 覆盖前备份沿用库目录机制（备份内含旧版 SKILL.md 与辅助文件）
    let backup = fs::read_dir(fx.dir.join("skill-backups"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pdf.")
        })
        .expect("覆盖前必须留下备份");
    assert!(fs::read_to_string(backup.join("SKILL.md"))
        .unwrap()
        .contains("旧描述"));
    assert!(backup.join("template.txt").exists());
    // description 缺省 = 保留原描述；不存在的技能报错
    let mut skills = fx.store.read();
    update_content_impl(&fx.store, &mut skills, "pdf", "第三版", None, None).unwrap();
    assert_eq!(fx.store.read()[0].description, "新描述");
    let err =
        update_content_impl(&fx.store, &mut skills, "ghost", "x", None, None).unwrap_err();
    assert!(err.contains("不存在"), "{err}");
}

#[test]
fn cursor_distribution_forces_copy_mode() {
    // cursor 的 skills 目录未验证 CLI 是否真读，强制 copy 不建 symlink；
    // grok 首版未经实机验证同样强制 copy。取值单一出处 = agent_specs.skill_dist
    use crate::agent_specs::{agent_spec, SkillDist};
    for a in ["cursor", "grok"] {
        assert!(
            matches!(agent_spec(a).unwrap().skill_dist, SkillDist::CopyOnly(r) if !r.is_empty()),
            "{a} 能力表应标 CopyOnly 且带原因"
        );
        assert!(!allow_symlink_for(a), "{a} 应强制 copy");
    }
    for a in [
        "claude-code",
        "codex",
        "gemini",
        "qwen",
        "opencode",
        "kimi",
        "codebuddy",
    ] {
        assert_eq!(
            agent_spec(a).unwrap().skill_dist,
            SkillDist::SymlinkOrCopy,
            "{a} 能力表应保持 symlink 优先"
        );
        assert!(allow_symlink_for(a), "{a} 应保持 symlink 优先");
    }
}

#[test]
fn apply_copy_fallback_marker_protection_and_conflicts() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    let target = fx.agents["codex"].join("pdf");
    // allow_symlink=false 强制 copy 回退：带标记文件
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
    assert!(target.join("SKILL.md").exists());
    assert!(target.join(MARKER_FILE).exists());
    assert!(fx.store.read()[0].apps["codex"]);
    // 关闭：带标记的副本被删除
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
    assert!(!target.exists());
    // 用户自有目录（无标记）：关闭时绝不动
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("SKILL.md"), "user's own").unwrap();
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
    assert!(target.join("SKILL.md").exists(), "无标记目录必须保留");
    // 同名冲突：开启时报错且不覆盖
    let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
    assert!(err.contains("不是由 Mesa 管理"), "{err}");
    assert_eq!(
        fs::read_to_string(target.join("SKILL.md")).unwrap(),
        "user's own"
    );
}

#[test]
fn apply_symlink_preferred_on_unix() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
    let target = fx.agents["claude-code"].join("pdf");
    #[cfg(unix)]
    assert!(fs::read_link(&target).is_ok(), "Unix 上应优先 symlink");
    // 重复应用（重挂）不出错
    apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
    apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", false, true).unwrap();
    assert!(!target.exists());
}

#[test]
fn delete_backups_up_and_prunes_to_five() {
    let fx = Fx::new();
    let backups = fx.dir.join("backups");
    fs::create_dir_all(&backups).unwrap();
    // 预置 5 份旧备份，删除后总数 6 → 剪掉最旧一份
    for i in 0..5 {
        fs::create_dir_all(backups.join(format!("pdf.2026070{i}-000000"))).unwrap();
    }
    let skill = fx.add_lib_skill("pdf", "x");
    delete_impl(&fx.store, &fx.agents, &backups, &skill.id).unwrap();
    assert!(fx.store.read().is_empty());
    assert!(!fx.store.skill_dir("pdf").exists());
    let remaining: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
    assert_eq!(remaining.len(), 5, "只保留最近 5 份");
    assert!(
        !backups.join("pdf.20260700-000000").exists(),
        "最旧的被剪掉"
    );
}

fn build_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(file);
    let opt = zip::write::SimpleFileOptions::default();
    for (name, data) in entries {
        w.start_file(name, opt).unwrap();
        std::io::Write::write_all(&mut w, data).unwrap();
    }
    w.finish().unwrap();
}

#[test]
fn zip_import_groups_skills_and_rejects_traversal() {
    let fx = Fx::new();
    let zip_path = fx.dir.join("in.zip");
    build_zip(
        &zip_path,
        &[
            (
                "repo-sha/skills/doc/docx/SKILL.md",
                b"---\ndescription: word\n---\n",
            ),
            ("repo-sha/skills/doc/docx/template.bin", b"\x00\x01"),
            (
                "repo-sha/skills/pdf/SKILL.md",
                b"---\ndescription: pdf\n---\n",
            ),
            ("../evil/SKILL.md", b"evil"),
            ("/abs/evil.md", b"evil"),
        ],
    );
    let mut skills = Vec::new();
    let result = import_zip_impl(
        &fx.store,
        &mut skills,
        &zip_path,
        None,
        "zip",
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.added.len(), 2);
    assert!(fx.store.skill_dir("docx").join("template.bin").exists());
    assert_eq!(
        skills
            .iter()
            .find(|s| s.name == "docx")
            .unwrap()
            .description,
        "word"
    );
    assert!(!fx.dir.join("evil").exists(), "路径穿越条目不得落盘");
    // subdir 过滤
    let fx2 = Fx::new();
    let result = import_zip_impl(
        &fx2.store,
        &mut Vec::new(),
        &zip_path,
        Some("skills/pdf"),
        "zip",
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.added.len(), 1);
    assert!(fx2.store.skill_dir("pdf").exists());
    assert!(!fx2.store.skill_dir("docx").exists());
}

#[test]
fn only_filter_updates_named_skill_and_ignores_rest() {
    // 一键更新的核心语义：zip 里只覆盖同名技能，其余不新增不覆盖
    let fx = Fx::new();
    fx.add_lib_skill("pdf", "旧版");
    let zip_path = fx.dir.join("upd.zip");
    build_zip(
        &zip_path,
        &[
            (
                "repo-sha/skills/pdf/SKILL.md",
                b"---\ndescription: new\n---\n",
            ),
            (
                "repo-sha/skills/docx/SKILL.md",
                b"---\ndescription: nope\n---\n",
            ),
        ],
    );
    let mut skills = fx.store.read();
    let resolutions = HashMap::from([("pdf".to_string(), "overwrite".to_string())]);
    let result = import_zip_impl(
        &fx.store,
        &mut skills,
        &zip_path,
        Some("skills"),
        "github",
        Some("o/r".to_string()),
        Some(&resolutions),
        Some("pdf"),
    )
    .unwrap();
    assert_eq!(result.updated, vec!["pdf".to_string()]);
    assert!(result.added.is_empty());
    assert!(
        !fx.store.skill_dir("docx").exists(),
        "only 过滤下 zip 其余技能不得进入"
    );
    assert_eq!(fx.store.read()[0].description, "new");
    // 目标不在 zip 中：空结果由调用方（apply_skill_update）转成「未找到」错误
    let result = import_zip_impl(
        &fx.store,
        &mut fx.store.read(),
        &zip_path,
        Some("skills"),
        "github",
        Some("o/r".to_string()),
        None,
        Some("ghost"),
    )
    .unwrap();
    assert!(result.added.is_empty() && result.updated.is_empty());
}

#[test]
fn zip_budget_rejects_too_many_entries() {
    let fx = Fx::new();
    let zip_path = fx.dir.join("many.zip");
    let file = fs::File::create(&zip_path).unwrap();
    let mut w = zip::ZipWriter::new(file);
    let opt = zip::write::SimpleFileOptions::default();
    for i in 0..(ZIP_MAX_ENTRIES + 1) {
        w.start_file(format!("f{i}.txt"), opt).unwrap();
    }
    w.finish().unwrap();
    let err = import_zip_impl(
        &fx.store,
        &mut Vec::new(),
        &zip_path,
        None,
        "zip",
        None,
        None,
        None,
    )
    .unwrap_err();
    assert!(err.contains("条目过多"), "{err}");
}

#[test]
fn export_roundtrips_through_zip_flow() {
    let fx = Fx::new();
    fx.add_lib_skill("pdf", "PDF 技能");
    fx.add_lib_skill("docx", "Word 技能");
    let ids: Vec<String> = fx.store.read().iter().map(|s| s.id.clone()).collect();
    let dest = fx.dir.join("out.zip");
    export_impl(&fx.store, &ids, dest.to_str().unwrap()).unwrap();
    // 再按 ZIP 导入流程进另一个库，验证往返一致
    let fx2 = Fx::new();
    let result = import_zip_impl(
        &fx2.store,
        &mut Vec::new(),
        &dest,
        None,
        "zip",
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.added.len(), 2);
    assert!(fx2.store.skill_dir("pdf").join("SKILL.md").exists());
    assert!(fx2.store.skill_dir("docx").join("SKILL.md").exists());
    // 空选择报错
    assert!(export_impl(&fx.store, &["nonexistent".into()], dest.to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn stale_copy_detected_and_resynced() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    // codex 走 copy（强制），gemini 走 symlink
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
    apply_impl(&fx.store, &fx.agents, &skill.id, "gemini", true, true).unwrap();
    let skill = fx
        .store
        .read()
        .into_iter()
        .find(|s| s.id == skill.id)
        .unwrap();
    assert!(
        stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
        "刚分发完不应有漂移"
    );
    // 库更新 → copy 副本漂移，symlink 不受影响
    fs::write(
        fx.store.skill_dir("pdf").join("SKILL.md"),
        "---\nname: pdf\ndescription: 新版\n---\nbody v2\n",
    )
    .unwrap();
    let stale = stale_agents(&fx.store, &fx.agents, &skill);
    assert_eq!(
        stale,
        vec!["codex".to_string()],
        "symlink 的 gemini 不算漂移"
    );
    let fixed = resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
    assert_eq!(fixed, vec!["codex".to_string()]);
    assert!(
        stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
        "resync 后漂移清零"
    );
    let copied = fs::read_to_string(fx.agents["codex"].join("pdf").join("SKILL.md")).unwrap();
    assert!(copied.contains("新版"), "副本内容已追平库");
    assert!(
        fx.agents["codex"].join("pdf").join(MARKER_FILE).exists(),
        "仍保持 copy 形态"
    );
}

#[test]
fn edited_content_reaches_copies() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
    let mut skills = fx.store.read();
    update_content_impl(&fx.store, &mut skills, "pdf", "body v2\n", None, None).unwrap();
    resync_names(&fx.store, &fx.agents, &["pdf".to_string()]);
    let copied = fs::read_to_string(fx.agents["codex"].join("pdf").join("SKILL.md")).unwrap();
    assert!(copied.contains("body v2"), "编辑后复制件跟上库");
}

#[test]
fn failed_restore_names_backup_location() {
    let fx = Fx::new();
    let dst = fx.store.skill_dir("pdf");
    let gone = fx.dir.join("no-such-backup");
    let err = restore_library_backup(Some(&gone), &dst, "复制失败".into());
    assert!(err.starts_with("复制失败；恢复原版本也失败"), "{err}");
    assert!(err.contains(&gone.display().to_string()));
    assert_eq!(restore_library_backup(None, &dst, "复制失败".into()), "复制失败");
}

#[test]
fn corrupt_registry_is_not_overwritten() {
    let fx = Fx::new();
    fs::write(&fx.store.json_path, "{broken").unwrap();
    assert!(fx.store.read().is_empty());
    let err = fx.store.write(&[]).unwrap_err();
    assert!(err.contains("无法解析"), "{err}");
    assert_eq!(fs::read_to_string(&fx.store.json_path).unwrap(), "{broken");
}

#[test]
fn store_lock_is_reentrant_and_serializes_writers() {
    let fx = Fx::new();
    {
        let _outer = fx.store.lock().unwrap();
        let _inner = fx.store.lock().unwrap();
    }
    assert_eq!(STORE_LOCK_DEPTH.with(|d| d.get()), 0);
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    let handles: Vec<_> = ["codex", "gemini", "qwen"]
        .into_iter()
        .map(|agent| {
            let (store, agents, id) = (fx.store.clone(), fx.agents.clone(), skill.id.clone());
            std::thread::spawn(move || {
                apply_impl(&store, &agents, &id, agent, true, false).unwrap()
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let saved = fx.store.read().into_iter().find(|s| s.id == skill.id).unwrap();
    for agent in ["codex", "gemini", "qwen"] {
        assert!(saved.apps[agent], "并发启用 {agent} 不被别的写入冲掉");
    }
}

#[test]
fn stale_detection_covers_whole_manifest() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v1").unwrap();
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
    let skill = fx
        .store
        .read()
        .into_iter()
        .find(|s| s.id == skill.id)
        .unwrap();
    assert!(
        stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
        "副本与库一致时不漂移（.ccode-copy 标记不参与比较）"
    );
    // 只改 SKILL.md 之外的辅助文件也必须检出漂移
    fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v2").unwrap();
    assert_eq!(
        stale_agents(&fx.store, &fx.agents, &skill),
        vec!["codex".to_string()]
    );
    // 库新增文件同样检出
    resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
    fs::write(fx.store.skill_dir("pdf").join("extra.txt"), "new").unwrap();
    assert_eq!(
        stale_agents(&fx.store, &fx.agents, &skill),
        vec!["codex".to_string()],
        "库新增文件也算漂移"
    );
}

#[test]
fn compact_iso_defensive_on_malformed() {
    assert_eq!(compact_iso("2026-07-30T10:13:37Z"), "20260730-101337");
    // 格式漂移（数字不足 9 位）不得 panic，原样返回已有数字
    assert_eq!(compact_iso("abc"), "");
    assert_eq!(compact_iso("2026"), "2026");
    assert_eq!(compact_iso("2026-07-30"), "20260730");
}

#[test]
fn find_skill_dirs_respects_depth_limit() {
    let fx = Fx::new();
    // 18 层嵌套深处藏一个技能：超过 MAX_WALK_DEPTH 不得被发现
    let deep = (0..18).fold(fx.dir.join("deep"), |p, i| p.join(format!("d{i}")));
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("SKILL.md"), "---\nname: too-deep\n---\n").unwrap();
    let mut found = Vec::new();
    find_skill_dirs(&fx.dir.join("deep"), &mut found);
    assert!(found.is_empty(), "超过深度上限的目录不得下钻");
}

#[cfg(unix)]
#[test]
fn walks_survive_symlink_loops() {
    let fx = Fx::new();
    // 真实空目录 a + 回指根目录的链接 up：路径解析次数随深度线性增长，
    // 保证命中我们自己的深度上限，而不是依赖 OS 的 ELOOP 行为
    let root = fx.dir.join("loop");
    fs::create_dir_all(root.join("a")).unwrap();
    std::os::unix::fs::symlink(&root, root.join("up")).unwrap();
    let mut found = Vec::new();
    find_skill_dirs(&root, &mut found); // 无深度上限时这里会无限递归
    assert!(found.is_empty());
    let err = copy_dir_recursive(&root, &fx.dir.join("loop-copy")).unwrap_err();
    assert!(err.contains("嵌套超过"), "{err}");
}

#[test]
fn charge_bytes_aborts_over_budget() {
    let mut total = 0;
    charge_bytes(&mut total, 100, 250).unwrap();
    charge_bytes(&mut total, 100, 250).unwrap();
    let err = charge_bytes(&mut total, 100, 250).unwrap_err();
    assert!(err.contains("预算"), "{err}");
}

#[test]
fn zip_budget_uses_injected_limit() {
    let fx = Fx::new();
    let zip_path = fx.dir.join("big.zip");
    build_zip(
        &zip_path,
        &[
            ("skill-a/SKILL.md", b"---\nname: a\n---\n"),
            ("skill-a/blob.bin", &[0u8; 200]),
        ],
    );
    // 声明总量 ~215 超过注入预算 100：预检拒绝
    let err = import_zip_limited(
        &fx.store,
        &mut Vec::new(),
        &zip_path,
        None,
        "zip",
        None,
        None,
        None,
        100,
    )
    .unwrap_err();
    assert!(err.contains("拒绝解压"), "{err}");
}

#[cfg(unix)]
#[test]
fn apply_failure_rolls_back_metadata() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::new();
    let skill = fx.add_lib_skill("pdf", "处理 PDF");
    apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
    assert!(fx.store.read()[0].apps["codex"]);
    // 库文件不可读 → 重复应用（先删旧分发再建新）的复制阶段必然失败
    let lib_file = fx.store.skill_dir("pdf").join("SKILL.md");
    fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o000)).unwrap();
    let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
    fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(err.contains("复制"), "{err}");
    assert!(
        !fx.store.read()[0].apps["codex"],
        "失败后元数据必须回落为未启用，不能显示启用但盘上无物"
    );
    assert!(!fx.agents["codex"].join("pdf").join(MARKER_FILE).exists());
}

#[test]
fn extract_skill_md_strips_fence_and_preamble() {
    let raw = "好的，我写好了：\n\n```markdown\n---\nname: model-watch\ndescription: 查模型\n---\n\n正文\n```\n";
    let got = extract_skill_md(raw);
    assert!(got.starts_with("---"));
    assert!(got.contains("name: model-watch"));
    assert!(got.contains("正文"));
    assert!(!got.contains("```"));
}

#[test]
fn create_from_full_md_sets_category_and_outputs() {
    let fx = Fx::new();
    let md = "---\nname: model-watch\ndescription: 查各家模型\noutputs:\n  - notes/watch-inbox.md\n---\n\n只追加清单，不改表。\n";
    let skill = create_skill_from_full_md_at(&fx.store, md, "fallback", Some("巡检"), None).unwrap();
    assert_eq!(skill.name, "model-watch");
    assert_eq!(skill.category.as_deref(), Some("巡检"));
    assert_eq!(skill.source, "ccode");
    let parsed = parse_skill_md(&fx.store.skill_dir("model-watch").join("SKILL.md"));
    assert_eq!(parsed.outputs, vec!["notes/watch-inbox.md".to_string()]);
}

#[test]
fn require_distributed_needs_apps_flag() {
    let fx = Fx::new();
    let skill = fx.add_lib_skill("model-watch", "查模型");
    let err = require_skill_distributed_at(&fx.store, "model-watch", "codex").unwrap_err();
    assert!(err.contains("未分发"));
    let mut skills = fx.store.read();
    skills[0].apps.insert("codex".into(), true);
    fx.store.write(&skills).unwrap();
    require_skill_distributed_at(&fx.store, "model-watch", "codex").unwrap();
    let err = require_skill_distributed_at(&fx.store, "ghost", "codex").unwrap_err();
    assert!(err.contains("技能库没有"));
    let _ = skill;
}

/// 卸载收回：只删指向技能库的链接；用户自己的链接、带标记的副本、库本身都不动；共用目录只扫一遍
#[cfg(unix)]
#[test]
fn unlink_links_into_removes_only_links_to_library() {
    let root =
        std::env::temp_dir().join(format!("ccode-skills-unlink-{}", uuid::Uuid::new_v4()));
    let lib = root.join("lib");
    let agent = root.join("agent-skills");
    let other = root.join("elsewhere");
    fs::create_dir_all(lib.join("bib-check")).unwrap();
    fs::create_dir_all(&agent).unwrap();
    fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(lib.join("bib-check"), agent.join("bib-check")).unwrap();
    std::os::unix::fs::symlink(&other, agent.join("user-link")).unwrap();
    fs::create_dir_all(agent.join("copied")).unwrap();
    fs::write(agent.join("copied").join(MARKER_FILE), "x").unwrap();
    let mut dirs = HashMap::new();
    dirs.insert("claude-code".to_string(), agent.clone());
    dirs.insert("codex".to_string(), agent.clone());

    assert!(unlink_links_into(&lib, &dirs).is_empty());
    assert!(fs::symlink_metadata(agent.join("bib-check")).is_err(), "指向库的链接已收回");
    assert!(fs::read_link(agent.join("user-link")).is_ok(), "用户自己的链接不动");
    assert!(agent.join("copied").is_dir(), "副本自成一份，留着");
    assert!(lib.join("bib-check").is_dir(), "库本身不动");
    fs::remove_dir_all(&root).ok();
}

/// 干跑：`CCODE_UNLINK_DRYRUN_DIR` 指向用 `cp -RP` 拷出的某家技能目录副本，按本机真实技能库收回
#[cfg(unix)]
#[test]
#[ignore]
fn real_skill_dir_unlink_dry_run() {
    let dir = PathBuf::from(std::env::var("CCODE_UNLINK_DRYRUN_DIR").expect("设 CCODE_UNLINK_DRYRUN_DIR"));
    let lib = SkillStore::default_paths().unwrap().lib;
    let mut dirs = HashMap::new();
    dirs.insert("dry".to_string(), dir.clone());
    let errors = unlink_links_into(&lib, &dirs);
    assert!(errors.is_empty(), "{errors:?}");
    for entry in fs::read_dir(&dir).unwrap().flatten() {
        let link = fs::read_link(entry.path()).ok();
        println!("留下：{} {:?}", entry.file_name().to_string_lossy(), link);
        assert!(!link.is_some_and(|l| crate::paths::path_within_path(&l, &lib)));
    }
}
