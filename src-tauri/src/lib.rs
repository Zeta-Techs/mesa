use tauri::{Emitter, Manager};

mod about;
mod attach_grants;
mod agent_specs;
mod client_open;
mod app_icon;
mod feedback;
mod agents;
mod ai;
mod artifacts;
mod citation;
mod cli_permission;
mod clipboard;
mod terminal_replay;
mod ccode_home;
mod coding;
mod combo;
mod config_dump;
mod custom_runtime;
mod dep_check;
mod diagnostics;
mod drift;
mod fonts;
mod fs_tree;
mod gateway_store;
mod git_info;
mod global_config;
mod handoff;
mod hooks;

/// 浏览器桥 helper（bin/mesa_helper.rs）的入库公共接口：同一套落盘口径
/// （注册项目根校验 + papers/ + 资源登记）。hint 用文献标题（回落 DOI）；
/// 返回 (落盘文件名, 是否字节级去重命中——扩展侧据此提示「已有同一份」)
pub fn helper_ingest(
    project_root: &str,
    hint: &str,
    bytes: &[u8],
) -> Result<(String, bool), String> {
    helper_ingest_ident(project_root, hint, hint, "", bytes)
}

/// 扩展入库：identity/doi 写进资源登记，待获取清单按标题认「已存」，不靠文件名
pub fn helper_ingest_ident(
    project_root: &str,
    file_hint: &str,
    identity: &str,
    doi: &str,
    bytes: &[u8],
) -> Result<(String, bool), String> {
    let root = projects::ensure_task_project_root(std::path::Path::new(project_root))?;
    let dto = lit_watch::save_paper_bytes_ident(&root, file_hint, identity, doi, bytes)?;
    Ok((dto.name, dto.dedup))
}

/// 扩展落盘文件名：页上标题优先；PDF 阅读器/站名等空标题回落 Mesa
/// 「浏览器打开」记下的那篇，再回落 DOI。空串则入库层用 paper.pdf。
pub fn helper_paper_name_hint(
    page_title: &str,
    page_doi: &str,
    page_url: &str,
    ctx_title: &str,
    ctx_doi: &str,
) -> String {
    lit_watch::pick_paper_name_hint(page_title, page_doi, page_url, ctx_title, ctx_doi)
}

/// 扩展按页上 DOI 找回「浏览器打开」登记的那篇（标题, DOI, 项目根）
pub fn helper_pending_for_doi(doi: &str) -> Option<(String, String, String)> {
    download_inbox::pending_for_doi(doi).map(|p| (p.title, p.doi, p.project_root))
}

/// helper 出图子命令（`mesa_helper image …`）：Agent 经 MESA_IMAGE_TOOL 调用，返回退出码
pub fn helper_image(args: &[String]) -> i32 {
    image_gen::helper_image_cli(args)
}
mod image_gen;

mod browser_bridge;
mod capability_golden;
mod capability_manifest;
mod download_inbox;
mod endnote;
mod gateway_balance;
mod inst_access;
mod journal_metrics;
mod lit_watch;
mod logbuf;
#[cfg(target_os = "macos")]
mod mac_fullscreen;
mod mcp;
mod mcp_blender;
mod model_registry;
mod models;
mod paths;
mod pdf;
mod phone_drop;
mod portwatch;
mod pricing;
mod process;
mod profile_validation;
mod profiles;
mod project_memory;
mod projects;
mod provider_id;
mod pty;
mod pty_input;
mod term_query;
mod program_status;
mod chat_channel;
mod chat_handoff_log;
mod context_breakdown;
mod reader;
mod research_quality;
mod research_tools;
mod review_contract;
mod runs;
mod scan_persist;
mod runtime;
mod scheduler;
mod session_search;
mod session_slim;
mod session_transfer;
mod sessions;
mod settings;
mod sheet_preview;
mod skills;
mod storage;
mod subscription_quota;
mod task_review;
mod tray;
mod uninstall;
mod updater;
mod usage;
mod watch_review;
mod win_snap;
mod workspaces;
mod internal_sessions;
mod ws_settings;
mod zotero;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    static CLOSE_DIALOG_OPEN: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static ALLOW_CLOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    /// 关窗存盘只拦一次（拦下→通知前端→350ms 后二次 close 放行）
    static FLUSH_CLOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static EXIT_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static EXIT_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    diagnostics::start_process_monitor();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 应用自更新（tauri-plugin-updater）+ 安装后重启（tauri-plugin-process）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 长任务 OS 通知（注意力跃迁：工作中→待确认/已完成，窗口未聚焦时）
        .plugin(tauri_plugin_notification::init())
        // 产物文件 OS 级拖出（v3.97：把 to-fetch.ris / PDF 从产物核验清单直接拖进 Zotero 等外部应用；
        // WebView 的 HTML5 拖拽出不了窗口，必须走系统拖拽会话）
        .plugin(tauri_plugin_drag::init())
        .manage(profiles::ProfileStore::new().expect("初始化 ProfileStore 失败"))
        .manage(pty::PtyManager::default())
        // 内置技能种子：启动时把库里没有的内置技能补进去（幂等，不覆盖用户已有同名技能）
        .setup(|app| {
            // 聊天层旁路：清上次崩溃留下的旁路目录；改为每次启动注入的几家，收回以前写进全局配置的 hooks
            chat_channel::prune_on_startup();
            hooks::migrate_launch_injected();
            // Windows 普通 shell 标签的目录记录文件：上次崩溃 / 强杀没删成的清掉
            pty::purge_cwd_track_files();
            if let Err(e) = runs::reconcile_stale_runs() {
                logbuf::record("warn", "runs", &format!("收口上次未完成 Run 失败: {e}"));
            }
            if let Err(e) = skills::seed_builtin_skills() {
                logbuf::record("warn", "skills", &format!("内置技能播种失败: {e}"));
            }
            // 定时雷达：60s tick 调度，启动首 tick 自动补跑关闭期间漏掉的任务
            scheduler::start_scheduler(app.handle().clone());
            // 内部对话保留期清理：开机两分钟后起，每天至多一次（设置页可关 / 改天数）
            internal_sessions::spawn_auto_cleanup();
            // 收货监听：启动即恢复（盘上登记在重启前留下的也要有人接）
            download_inbox::ensure_watcher_at_startup(app.handle());
            // 浏览器桥自愈：清单写死的是安装当时的 helper 绝对路径，应用被移动
            // （DMG → /Applications）后 path 失效——启动时发现不一致就重写；
            // 扩展目录同步就位到 <config>/ccode/extension（打包用户可点的路径）
            browser_bridge::selfheal_bridge_manifests();
            if let Err(e) = browser_bridge::stage_extension_files() {
                logbuf::record("warn", "browser-bridge", &format!("扩展目录就位失败: {e}"));
            }
            // 扩展「存到 Mesa」的回执监听：helper 是独立进程不发 Tauri 事件，
            // 这里把收货回执变成 inst-papers-changed 广播给清单/雷达
            browser_bridge::spawn_receipts_watch(app.handle().clone());
            if let Err(e) = tray::setup(app.handle()) {
                logbuf::record("warn", "tray", &format!("托盘初始化失败: {e}"));
            }
            // 托盘建好后再挂：应用图标外观要连托盘一起换
            app_icon::apply_saved(app.handle());
            // Windows 老用户：已开的精确注意力钩子若还是旧版内联写法（从不生效），后台换成新写法；
            // 之后（三平台）给开着的 Gemini 钩子补上名字（hooks::refresh_gemini_hook_name）
            #[cfg(windows)]
            std::thread::spawn(|| {
                hooks::migrate_legacy_windows_hooks();
                hooks::refresh_gemini_hook_name();
            });
            #[cfg(not(windows))]
            std::thread::spawn(hooks::refresh_gemini_hook_name);
            // macOS 菜单栏：应用子菜单带 About 面板（版权 / 许可入口）。set_menu 会
            // 整体替换默认菜单——编辑子菜单的复制粘贴等预置项必须显式带上，否则
            // 文本框的系统快捷键全失灵。仅 macOS：Windows 无菜单栏惯例。
            // v3.259 起按 HIG 补命令覆盖：设置/命令面板归 app 菜单，窗口/帮助子菜单，
            // 菜单事件经 "menu:action" 转给前端（App.tsx 监听）。
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
                };
                let about = PredefinedMenuItem::about(
                    app.handle(),
                    None,
                    Some(AboutMetadata {
                        name: Some("Mesa".into()),
                        copyright: Some("Copyright 2026 泽塔前沿科技（杭州）有限公司".into()),
                        credits: Some(
                            "按 Apache-2.0 开源；第三方组件与字体许可见 设置 → 关于 → 开源许可。\n\
                             设计参考 cc-switch / waveterm / VS Code"
                                .into(),
                        ),
                        ..Default::default()
                    }),
                )?;
                let settings_item = MenuItemBuilder::with_id("settings", "设置…")
                    .accelerator("CmdOrCtrl+Comma")
                    .build(app)?;
                let palette_item = MenuItemBuilder::with_id("palette", "命令面板")
                    .accelerator("CmdOrCtrl+K")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Mesa")
                    .item(&about)
                    .separator()
                    .item(&settings_item)
                    .item(&palette_item)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "编辑")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "窗口")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .separator()
                    .close_window()
                    .build()?;
                let docs_item =
                    MenuItemBuilder::with_id("docs", "Mesa 文档").build(app)?;
                let feedback_item =
                    MenuItemBuilder::with_id("feedback", "反馈问题").build(app)?;
                let help_menu = SubmenuBuilder::new(app, "帮助")
                    .item(&docs_item)
                    .item(&feedback_item)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .item(&help_menu)
                    .build()?;
                app.set_menu(menu)?;
                // settings/palette/feedback 走事件桥交给前端（反馈开应用内表单）；文档直接系统 opener 打开
                app.on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "settings" => {
                        let _ = app_handle.emit("menu:action", "settings");
                    }
                    "palette" => {
                        let _ = app_handle.emit("menu:action", "palette");
                    }
                    "docs" => {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = app_handle
                            .opener()
                            .open_url("https://github.com/hongtongzhou-design/ccode", None::<&str>);
                    }
                    "feedback" => {
                        // 反馈走应用内表单（2026-10-12 拍板：不跳 GitHub）——
                        // 经事件桥开 FeedbackModal，与帮助菜单同一出口
                        let _ = app_handle.emit("menu:action", "feedback");
                    }
                    _ => {}
                });
            }
            // 配置里的 windowEffects 在建窗时就会套。这里再挂一次，兜住没带上的情况。
            if let Some(window) = app.get_webview_window("main") {
                // Windows：去掉原生标题栏，前端自绘拖拽区与窗口按钮（与 macOS Overlay 同构）。
                // 不能放进 tauri.conf：titleBarStyle 只在 macOS 生效，dev 配置覆盖时
                // windows 数组整体替换，平台配置会丢。
                #[cfg(target_os = "windows")]
                if let Err(e) = window.set_decorations(false) {
                    logbuf::record("warn", "window", &format!("原生标题栏未去掉: {e}"));
                }
                // 窗口外观必须先于材质定下来：macOS 材质是 NSVisualEffectView，
                // 底色由 NSAppearance 决定，不跟应用主题走。系统深色 + 应用浅色时材质本体
                // 是近黑的，浅色那层罩色压不住，四周缝与圆角处就渗黑边。
                //
                // 放在 set_effects 之前而不是之后：材质是按当前外观渲染的，先定外观再挂材质，
                // 首帧就是对的；反过来的话启动瞬间还会闪一下深色材质。
                // 跟随系统深浅时外观本就是系统的（前端把主题校正成同深浅的 twin），不强制
                if !settings::current_theme_follows_system() {
                    let light = settings::current_theme_is_light();
                    let appearance = if light {
                        tauri::utils::Theme::Light
                    } else {
                        tauri::utils::Theme::Dark
                    };
                    // Linux / macOS 上主题是应用级（不受 this window 局限，见 tauri Window::set_theme 文档），
                    // 保持单一主窗与 tray 的一致性正是我们要的。
                    if let Err(e) = window.set_theme(Some(appearance)) {
                        logbuf::record("warn", "window", &format!("窗口外观未挂上: {e}"));
                    }
                }

                // macOS 用菜单材质（Menu），不用 UnderWindowBackground（2026-10-23，对照 Codex 客户端）：
                // 后者只模糊不压色，全屏时整面都是桌面壁纸，彩色壁纸的色相直接透上来；
                // 菜单材质本身更实、饱和度压得低，壁纸只剩一层偏灰的明暗。必须与各份 tauri*.conf.json 同步。
                let effects = tauri::utils::config::WindowEffectsConfig {
                    effects: vec![
                        tauri::utils::WindowEffect::Menu,
                        tauri::utils::WindowEffect::Mica,
                    ],
                    state: Some(tauri::utils::WindowEffectState::FollowsWindowActiveState),
                    radius: None,
                    color: None,
                };
                if let Err(e) = window.set_effects(effects) {
                    logbuf::record("warn", "window", &format!("桌面磨砂未挂上: {e}"));
                }
                // WKWebView 即使窗口 transparent，网页层仍会铺实心底。
                // 关掉 drawsBackground，侧栏罩色才能透出桌面磨砂。
                #[cfg(target_os = "macos")]
                {
                    // 全屏切换一开始就告诉前端，壳的实心底跟着系统动画淡变（mac_fullscreen.rs）
                    mac_fullscreen::observe(&window);
                    let _ = window.with_webview(|webview| unsafe {
                        use objc2::runtime::AnyObject;
                        let wk = &*(webview.inner() as *mut AnyObject);
                        let no: *mut AnyObject = objc2::msg_send![
                            objc2::class!(NSNumber),
                            numberWithBool: false
                        ];
                        let key: *mut AnyObject = objc2::msg_send![
                            objc2::class!(NSString),
                            stringWithUTF8String: b"drawsBackground\0".as_ptr()
                        ];
                        let _: () = objc2::msg_send![wk, setValue: no, forKey: key];
                        let clear: *mut AnyObject = objc2::msg_send![
                            objc2::class!(NSColor),
                            clearColor
                        ];
                        let color_key: *mut AnyObject = objc2::msg_send![
                            objc2::class!(NSString),
                            stringWithUTF8String: b"underPageBackgroundColor\0".as_ptr()
                        ];
                        let _: () = objc2::msg_send![wk, setValue: clear, forKey: color_key];
                        eprintln!("[window] webview background cleared");
                    });
                    // 清底发生在首屏绘制前。WKWebView 随后还会自己铺一层不透明底，
                    // 晚一拍再清一次，侧栏罩色才能稳住透出的桌面。
                    let again = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        let _ = again.with_webview(|webview| unsafe {
                            use objc2::runtime::AnyObject;
                            let wk = &*(webview.inner() as *mut AnyObject);
                            let no: *mut AnyObject = objc2::msg_send![
                                objc2::class!(NSNumber),
                                numberWithBool: false
                            ];
                            let key: *mut AnyObject = objc2::msg_send![
                                objc2::class!(NSString),
                                stringWithUTF8String: b"drawsBackground\0".as_ptr()
                            ];
                            let _: () = objc2::msg_send![wk, setValue: no, forKey: key];
                        });
                    });
                }
            }
            Ok(())
        })
        .on_webview_event(|_webview, event| {
            // 拖进窗口的文件登记为「用户交给 Mesa 的」，附件卡据此出缩略图（attach_grants.rs）
            if let tauri::WebviewEvent::DragDrop(drop) = event {
                attach_grants::grant_drop(drop);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drop) = event {
                attach_grants::grant_drop(drop);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if process::capture_count() > 0
                    && !ALLOW_CLOSE.load(std::sync::atomic::Ordering::Acquire)
                {
                    use tauri_plugin_dialog::DialogExt;
                    api.prevent_close();
                    if CLOSE_DIALOG_OPEN.swap(true, std::sync::atomic::Ordering::AcqRel) {
                        return;
                    }
                    let window = window.clone();
                    window
                        .app_handle()
                        .dialog()
                        .message("仍有后台任务运行，退出将终止这些任务。确认退出？")
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                        .show(move |ok| {
                            CLOSE_DIALOG_OPEN.store(false, std::sync::atomic::Ordering::Release);
                            if ok {
                                ALLOW_CLOSE.store(true, std::sync::atomic::Ordering::Release);
                                let _ = window.close();
                            }
                        });
                    return;
                }
                // 关窗存盘（2026-10-11 实机实证：前端 onCloseRequested 在红绿灯关窗时
                // 不执行，终端回放的「关窗存点」乃至 agent 关窗确认守卫整条 JS 链路是
                // 死的）。这里在 Rust 侧拦一次：通知前端各标签存回放，等 350ms 落盘
                // 再放行关闭；FLUSH_CLOSE 保证只拦一次、二次 close 直接过。
                if !FLUSH_CLOSE.load(std::sync::atomic::Ordering::Acquire) {
                    api.prevent_close();
                    FLUSH_CLOSE.store(true, std::sync::atomic::Ordering::Release);
                    let window = window.clone();
                    let _ = window.emit("mesa:flush-before-close", ());
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(350));
                        let _ = window.close();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            profiles::list_profiles,
            profiles::create_profile,
            profiles::update_profile,
            profiles::delete_profile,
            profiles::profile_usage_refs,
            profiles::clear_profile_key,
            profiles::duplicate_profile,
            profiles::copy_profile_to_agent,
            profiles::export_profiles,
            profiles::import_profiles,
            profiles::export_gateways_v2,
            profiles::import_gateways_v2,
            profiles::list_gateways,
            profiles::merge_gateway_models,
            profiles::save_gateway,
            profiles::delete_gateway,
            profiles::bind_gateway,
            profiles::unbind_split_merge,
            profiles::clear_gateway_key,
            profiles::clear_gateway_wallet_token,
            combo::combo_surface,
            combo::combo_surface_for_gateway,
            combo::combo_surface_for_gateway_batch,
            tray::rebuild_tray,
            app_icon::apply_app_icon,
            cli_permission::cli_default_permission,
            profile_validation::validate_profile,
            profile_validation::probe_gateway,
            profile_validation::probe_gateway_slot,
            agents::detect_agents,
            agents::preview_launch_plan,
            agents::official_account_status,
            agents::clear_account_conflicts,
            agents::session_resume_command,
            agents::resume_external_terminal,
            agents::new_external_terminal,
            agents::session_digest_command,
            agents::digest_external_terminal,
            models::fetch_models,
            models::fetch_gateway_catalog,
            image_gen::image_gen_candidates,
            image_gen::image_gen_status,
            image_gen::image_gen_test,
            model_registry::model_db_status,
            model_registry::download_model_db,
            model_registry::model_capability_brief,
            global_config::check_global_drift,
            global_config::preview_profile_global,
            global_config::apply_profile_global,
            global_config::set_global_conflict,
            client_open::client_open_list,
            client_open::client_open_plan,
            client_open::client_open_launch,
            global_config::restore_global_backup,
            global_config::has_global_backup,
            global_config::has_original_backup,
            global_config::restore_original_backup,
            pty::pty_spawn,
            pty::pty_spawn_custom,
            pty::pty_id_for_run,
            runs::run_open,
            runs::run_open_custom,
            runs::run_close,
            runs::run_cancel,
            runs::active_background_runs,
            runs::run_attach_session,
            artifacts::run_artifacts,
            runs::run_get,
            runs::run_list,
            runs::run_find,
            runs::run_events,
            runs::task_goal_events,
            runs::task_get,
            runs::task_list,
            runs::task_create,
            runs::task_set_launch,
            runs::task_update,
            runs::task_delete,
            runs::task_unarchive,
            runs::task_purge_archived,
            runs::goal_storage::task_storage_review,
            runs::goal_storage::task_cleanup,
            runs::task_prepare_run,
            runs::task_input_estimate,
            runs::task_output_changes,
            runs::task_run_context,
            runs::task_freeze_turn,
            runs::task_freeze_large_outputs,
            projects::read_project_memory,
            project_memory::project_memory_read,
            project_memory::project_memory_update,
            projects::read_acceptance_log,
            runs::task_adopt_outputs,
            runs::task_recover_outputs,
            custom_runtime::list_custom_runtimes,
            custom_runtime::save_custom_runtime,
            custom_runtime::delete_custom_runtime,
            coding::coding_upsert_lane,
            pty::shell_spawn,
            pty::pty_write,
            pty::pty_write_submit,
            pty::pty_report_terminal_colors,
            pty::pty_resize,
            pty::pty_kill,
            pty::terminal_link_target,
            clipboard::save_clipboard_image,
            clipboard::read_clipboard_files,
            terminal_replay::save_terminal_replay,
            terminal_replay::load_terminal_replay,
            terminal_replay::drop_terminal_replay,
            terminal_replay::prune_terminal_replays,
            pty::pty_set_visible,
            pty::pty_subscribe,
            pty::pty_ack,
            pty::pty_get_cwd,
            pty::terminal_shell_options,
            pty::pty_cd,
            win_snap::window_show_snap_layouts,
            pty::pty_has_running_process,
            sessions::list_sessions,
            sessions::find_session,
            session_search::search_sessions,
            session_search::locate_session_matches,
            sessions::claim_session_for,
            sessions::claim_session_successor,
            sessions::release_session_claim,
            sessions::get_session_conversation,
            sessions::get_session_conversation_page,
            sessions::session_file_sig,
            sessions::watch_session,
            sessions::unwatch_session,
            sessions::pin_session,
            sessions::unpin_session,
            sessions::set_session_meta,
            sessions::set_session_profile_command,
            sessions::session_resume_config,
            sessions::assign_session_task,
            sessions::claim_next_session_for_card,
            sessions::claim_next_session_for_step,
            sessions::delete_session,
            internal_sessions::internal_sessions_stats,
            internal_sessions::cleanup_internal_sessions,
            sessions::delete_project_sessions,
            sessions::session_tail_state,
            sessions::session_permission_mode,
            sessions::export_session_markdown,
            session_slim::session_slim_inspect,
            session_slim::session_slim_apply,
            session_transfer::export_sessions,
            session_transfer::import_sessions_inspect,
            session_transfer::import_sessions_apply,
            handoff::handoff_targets,
            handoff::build_handoff_brief,
            handoff::build_session_digest,
            handoff::finalize_digest_brief,
            handoff::list_legacy_briefs,
            handoff::mark_handoff,
            logbuf::get_app_log,
            logbuf::clear_app_log,
            logbuf::export_app_log,
            logbuf::log_event,
            diagnostics::export_diagnostics_bundle,
            config_dump::dump_effective_config,
            config_dump::export_effective_config,
            agent_specs::agent_capabilities,
            agent_specs::codex_win_sandbox_state,
            model_registry::model_capabilities,
            model_registry::list_model_capability_overrides,
            model_registry::set_model_capability_override,
            model_registry::clear_model_capability_override,
            mcp::list_mcp_servers,
            mcp::save_mcp_server,
            mcp::set_mcp_server_app,
            mcp::set_mcp_server_enabled,
            mcp::delete_mcp_server,
            mcp::check_mcp_server,
            mcp::check_all_mcp_servers,
            mcp::mcp_missing_env_refs,
            mcp::list_mcp_env_secrets,
            mcp::academic_mcp_login_status,
            mcp::mcp_agent_status,
            mcp::discover_mcp_servers,
            mcp::import_mcp_from_agent,
            mcp::import_mcp_json,
            mcp::parse_mcp_json,
            mcp::mcp_command_path_status,
            mcp::resolve_mcp_command_fix,
            mcp_blender::probe_blender_mcp_setup,
            fs_tree::list_dir,
            fs_tree::read_file_preview,
            research_tools::research_tool_preflight,
            research_quality::research_source,
            research_quality::research_run_reproduce,
            research_quality::research_get_run,
            research_quality::research_read_run_file,
            research_quality::research_save_acceptance,
            research_quality::research_get_acceptance,
            research_quality::research_upstream_acceptances,
            fs_tree::save_file_preview,
            fs_tree::watch_dir,
            fs_tree::unwatch_dir,
            fs_tree::search_files,
            fs_tree::existing_files,
            fs_tree::list_office_docs,
            fs_tree::open_in_system,
            fs_tree::fs_create_dir,
            fs_tree::fs_delete_path,
            fs_tree::home_dir,
            fs_tree::default_project_parent,
            pdf::read_pdf_bytes,
            pdf::read_docx_bytes,
            sheet_preview::read_sheet_preview,
            citation::check_citation_health,
            citation::cite_lookup,
            git_info::git_status,
            git_info::git_file_diff,
            git_info::git_file_hunks,
            git_info::apply_hunk,
            git_info::git_image_pair,
            git_info::git_commit,
            git_info::git_push,
            git_info::git_abort_merge,
            git_info::git_status_map,
            git_info::project_history,
            git_info::workspace_diff,
            git_info::workspace_file_diff,
            updater::update_agent,
            updater::install_agent,
            updater::install_method_preview,
            updater::updater_write,
            updater::check_agent_updates,
            dep_check::check_dependencies,
            dep_check::install_dependency,
            fonts::font_status,
            fonts::install_font,
            workspaces::create_workspace,
            workspaces::list_workspaces,
            workspaces::archive_workspace,
            workspaces::restore_workspace,
            workspaces::delete_workspace,
            workspaces::workspace_env_for,
            workspaces::register_artifact,
            workspaces::read_artifacts_manifest,
            workspaces::workspace_health,
            workspaces::workspace_review_deliverables,
            workspaces::pending_artifact_checks,
            workspaces::list_human_task_states,
            workspaces::set_human_task_check,
            workspaces::import_human_deliverable,
            workspaces::list_help_requests,
            workspaces::write_review_notes,
            workspaces::workspace_drift,
            workspaces::workspace_repair_remount,
            workspaces::workspace_relocate_repo,
            workspaces::workspace_mark_archived,
            workspaces::workspace_clean_record,
            workspaces::merge_workspace,
            workspaces::workspace_sync_base,
            workspaces::workspace_unmerged_files,
            workspaces::workspace_conflict_content,
            workspaces::workspace_resolve_file,
            workspaces::workspace_finish_merge,
            workspaces::path_context,
            workspaces::create_pr,
            workspaces::list_repos,
            portwatch::list_listening_ports,
            portwatch::kill_port_process,
            ws_settings::workspace_settings,
            ws_settings::upsert_project_run_scripts,
            projects::list_projects,
            projects::register_project,
            projects::set_project_default_agent,
            projects::set_project_default_profile,
            projects::set_project_agent_binding,
            projects::get_project_agent_binding,
            projects::remove_project,
            projects::delete_project_dir,
            projects::purge_project_traces,
            projects::read_project_config,
            projects::project_set_session_injection,
            projects::read_project_status,
            projects::write_project_config,
            projects::update_step_skills,
            projects::read_task_draft,
            projects::append_step_draft,
            projects::discover_resources,
            projects::ensure_git_repo,
            projects::commit_project_bootstrap,
            projects::create_demo_project,
            projects::write_workspace_task_md,
            projects::inspect_step_inputs,
            zotero::zotero_inspect,
            zotero::zotero_items,
            zotero::zotero_import,
            zotero::zotero_attach_fulltexts,
            zotero::zotero_bbt_status,
            zotero::zotero_install_bbt,
            zotero::zotero_open_import,
            endnote::endnote_export_xml,
            zotero::zotero_match_dois,
            zotero::zotero_open_papers,
            projects::pdf_owner_project,
            projects::append_notes_excerpt,
            projects::append_project_clip,
            projects::list_pipeline_templates,
            projects::save_pipeline_template,
            projects::delete_pipeline_template,
            projects::ensure_scratch_dir,
            projects::append_pipeline_steps,
            projects::append_pipeline_steps_with_submission,
            projects::apply_pipeline_template,
            projects::set_pipeline_opt_out,
            projects::set_work_mode,
            coding::coding_overview,
            coding::coding_create_worktree,
            coding::coding_remove_worktree,
            coding::coding_fetch,
            coding::coding_pull,
            coding::coding_push,
            coding::coding_merge_into_base,
            coding::coding_delete_branch,
            coding::coding_add_origin,
            coding::coding_open_desktop,
            coding::coding_open_pr,
            coding::git_is_repo,
            projects::fuse_card_into_draft,
            projects::write_task_draft,
            projects::list_task_cards,
            projects::create_task_card,
            projects::rename_task_card,
            projects::delete_task_card,
            skills::list_skills,
            skills::set_skill_category,
            skills::set_skill_tags,
            skills::count_enabled_skills,
            skills::apply_skill,
            skills::delete_skill,
            skills::import_skills_from_dir,
            skills::import_skills_from_zip,
            skills::import_skills_from_github,
            skills::check_skill_updates,
            skills::apply_skill_update,
            skills::check_builtin_skill_updates,
            skills::apply_builtin_skill_update,
            skills::preview_builtin_skill_update,
            skills::backfill_skill_categories,
            skills::discover_unmanaged,
            skills::import_discovered,
            skills::export_skills,
            skills::read_skill_md,
            skills::create_skill,
            skills::update_skill_content,
            skills::write_skill_md,
            skills::adapt_skill_to_pipeline,
            skills::optimize_skills_draft,
            skills::create_user_skill,
            skills::skill_md_path,
            skills::resync_skill_copies,
            usage::rebuild_usage_index,
            usage::get_usage_stats,
            usage::usage_trend,
            subscription_quota::plan_quota_overview,
            subscription_quota::plan_use_reset_card,
            subscription_quota::plan_quota_console_url,
            gateway_balance::gateway_balance_overview,
            usage::top_sessions,
            usage::session_usage,
            usage::usage_by_gateway,
            usage::usage_unpriced_models,
            usage::usage_activity,
            usage::usage_day_detail,
            usage::usage_activity_agents,
            settings::get_settings,
            settings::detect_outbound_proxy,
            settings::app_storage_usage,
            settings::clear_storage_entry,
            uninstall::uninstall_mesa,
            mcp::mcp_distribution_status,
            settings::update_settings,
            settings::set_workspace_root,
            hooks::set_hooks_attention,
            hooks::hooks_attention_support,
            hooks::session_confirm_detail,
            chat_channel::chat_channel_snapshot,
            chat_channel::chat_channel_settle_from_transcript,
            chat_channel::chat_channel_reply,
            chat_handoff_log::chat_handoff_record,
            chat_handoff_log::chat_handoff_summary,
            chat_handoff_log::chat_handoff_clear,
            context_breakdown::context_breakdown,
            ai::ai_prompt,
            ai::ai_commit_message,
            ai::ai_summarize_session,
            ai::ai_auto_title_session,
            ai::ai_retitle_all_sessions,
            ai::ai_draft_pr,
            ai::ai_conflict_advice,
            ai::ai_distill_skill,
            ai::ai_distill_review,
            pricing::read_pricing_file,
            pricing::write_pricing_file,
            scheduler::list_schedules,
            scheduler::create_schedule,
            scheduler::update_schedule,
            scheduler::delete_schedule,
            scheduler::run_schedule_now,
            scheduler::cancel_schedule_run,
            scheduler::adopt_watch_run,
            scheduler::schedule_run_delete,
            watch_review::watch_run_snapshot,
            watch_review::watch_run_entries,
            watch_review::watch_run_decide,
            scheduler::start_watch_skill_draft,
            scheduler::list_watch_skill_drafts,
            scheduler::read_watch_skill_draft,
            scheduler::write_watch_skill_draft,
            scheduler::discard_watch_skill_draft,
            scheduler::commit_watch_skill_draft,
            scheduler::ensure_schedule_skill_distributed,
            scheduler::schedule_memory_read,
            scheduler::schedule_memory_write,
            lit_watch::list_watch_entries,
            lit_watch::repair_watch_batch_dates,
            lit_watch::save_watch_explain,
            lit_watch::list_watch_subscriptions,
            lit_watch::save_watch_subscriptions,
            lit_watch::ensure_watch_subscriptions_file,
            lit_watch::list_included_entries,
            lit_watch::list_reading_list_entries,
            lit_watch::add_reading_list_entry,
            lit_watch::remove_reading_list_entry,
            lit_watch::freeze_reading_list_intake,
            lit_watch::download_paper_pdf,
            lit_watch::attach_paper_pdf,
            lit_watch::fetch_paper_fulltext,
            lit_watch::match_dropped_paper,
            lit_watch::to_fetch_progress,
            inst_access::inst_session_status,
            browser_bridge::install_browser_bridge,
            download_inbox::inst_browser_open,
            download_inbox::inst_browser_cancel,
            inst_access::inst_open_login,
            inst_access::inst_open_url,
            inst_access::inst_save_relayed_pdf,
            inst_access::inst_capture_session,
            inst_access::inst_clear_session,
            fs_tree::drop_fetch_line,
            fs_tree::drop_ris_record,
            fs_tree::read_research_ledger,
            fs_tree::save_research_ledger,
            journal_metrics::lookup_journal_metrics,
            journal_metrics::journal_metrics_status,
            journal_metrics::download_journal_metrics,
            journal_metrics::check_journal_metrics_update,
            projects::update_lit_watch_filter,
            reader::ensure_paper_note,
            reader::pdf_for_note,
            reader::list_paper_notes,
            reader::reader_for_note,
            reader::read_image_bytes,
            attach_grants::pick_attachment_files,
            reader::read_audio_bytes,
            reader::save_reader_capture,
            reader::append_note_image,
            reader::list_glossary,
            reader::append_glossary,
            reader::remove_glossary_entry,
            reader::append_note_translation,
            reader::append_note_annotation,
            reader::remove_note_annotation,
            reader::reader_paper_title,
            about::read_third_party_notices,
            about::build_info,
            feedback::feedback_endpoint,
            feedback::feedback_error_log,
            feedback::submit_feedback,
            feedback::test_feedback_smtp,
            feedback::save_feedback_images,
            feedback::set_feedback_smtp_secret,
            feedback::clear_feedback_smtp_secret,
            feedback::send_feedback_smtp,
            settings::clear_feedback_smtp_config,
            phone_drop::phone_drop_start,
            phone_drop::phone_drop_stop,
            phone_drop::phone_drop_status,
            phone_drop::phone_drop_list,
            phone_drop::phone_drop_set_status,
            phone_drop::phone_drop_place,
            phone_drop::phone_drop_save_as,
            phone_drop::phone_drop_delete,
            phone_drop::phone_drop_devices,
            phone_drop::phone_drop_remove_device,
            phone_drop::phone_drop_sync,
            phone_drop::phone_drop_set_standby,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS 开发态 tauri 在 Ready 时自设一次程序坞图标，按设置再压一遍
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Ready = event {
                app_icon::apply_saved(app);
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if EXIT_READY.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                api.prevent_exit();
                if EXIT_STARTED.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    return;
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    process::shutdown_captures();
                    app.state::<pty::PtyManager>().shutdown();
                    chat_channel::shutdown_all();
                    phone_drop::shutdown();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while process::capture_count() > 0 && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    EXIT_READY.store(true, std::sync::atomic::Ordering::Release);
                    app.exit(code.unwrap_or(0));
                });
            }
        });
}
