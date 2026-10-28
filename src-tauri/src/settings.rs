//! 应用级设置（<config>/ccode/settings.json）：全部字段可选，读取侧与默认值合并。
//! 消费点：终端外观（前端）、usage 汇率、updater 的 brew 镜像开关、长任务 OS 通知开关（前端）。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub const DEFAULT_TERMINAL_FONT_SIZE: u16 = 14;
pub const DEFAULT_SCROLLBACK: u32 = 5000;
pub const DEFAULT_RATE_USD_CNY: f64 = 7.2;
pub const DEFAULT_BREW_MIRROR: bool = true;
pub const DEFAULT_NOTIFICATIONS_ENABLED: bool = true;
/// 会话自动命名（聊完起名 + 打开对话页补名去重）默认开；关 = 全停，手改标题不受影响
pub const DEFAULT_AUTO_TITLE_SESSIONS: bool = true;
pub const DEFAULT_NAV_CAPSULE_RUN_ANNOUNCE: bool = true;
/// 首次安装的主题与「跟随系统深浅」（2026-10-26 用户拍板：极简灰蓝深色 + 不跟随；
/// 原 2026-10-22 琥珀 + 跟随）。不跟随才能保证新用户首屏就是深色，系统浅色也不换成浅色那套。
/// 前端兜底在 themes.ts DEFAULT_THEME_ID，两边同步；存过值的老设置不受影响
pub const DEFAULT_THEME: &str = "neutral";
pub const DEFAULT_THEME_FOLLOW_SYSTEM: bool = false;
pub const DEFAULT_TERMINAL_FONT_FAMILY: &str = "JetBrains Mono";
/// 全局快捷键默认绑定（前端 hotkeys.ts 解析；mod = macOS ⌘ / 其他平台 Ctrl）
pub const DEFAULT_HOTKEY_PALETTE: &str = "mod+k";
pub const DEFAULT_HOTKEY_HIDE_CHROME: &str = "mod+\\";
/// 新对话（侧栏「新对话」同一入口，2026-10-24）与「光标移到侧栏对话」（↑↓ 选、回车打开）
pub const DEFAULT_HOTKEY_NEW_CHAT: &str = "mod+n";
pub const DEFAULT_HOTKEY_FOCUS_RAIL: &str = "mod+0";
/// 运行页聊天 / 终端来回切（2026-10-25；光标在终端里也接）
pub const DEFAULT_HOTKEY_TOGGLE_SURFACE: &str = "mod+shift+t";
/// 新项目（侧栏顶部「新项目」，2026-10-27）与「搜索对话和项目」（标题栏放大镜）
pub const DEFAULT_HOTKEY_NEW_PROJECT: &str = "mod+shift+n";
pub const DEFAULT_HOTKEY_RAIL_SEARCH: &str = "mod+shift+f";
pub const DEFAULT_HOTKEY_PAGE_SWITCH: bool = true;
pub const DEFAULT_NAV_CAPSULE_HIDE_DELAY_MS: u32 = 1000;
/// 侧栏 / 顶栏罩色的透明度系数（百分比，100 = 各主题本来的罩色，越小越透）。
/// 挡位不是范围：见 KNOWN_CHROME_OPACITIES 的说明。
pub const DEFAULT_CHROME_OPACITY: u32 = 100;
const KNOWN_THEMES: [&str; 16] = [
    "midnight",
    "terracotta",
    "ayu",
    "mocha",
    "neutral",
    "dracula",
    "shadcn",
    "midnight-light",
    "terracotta-light",
    "ayu-light",
    "mocha-light",
    "neutral-light",
    "dracula-light",
    "shadcn-light",
    "custom",
    "custom-light",
];
/// 「启动时进入」白名单（与前端 src/start-page.ts START_PAGE_OPTIONS 同步）。2026-10-24 起是四种去处，
/// 不再是页面 id；旧存值（workspaces / sessions 这些）不在表里，读出来落回 None = 工作台
const KNOWN_START_PAGES: [&str; 4] = ["workbench", "last-chat", "last-project", "new-chat"];
/// 终端 ANSI 调色板：四套深色 + 四套配对浅色。
/// 单一出处在前端 `src/terminal-palettes.ts` 的 PALETTE_LIST，此处是持久化白名单，两边须同步
/// （不在名单里的值会被静默丢弃，表现为「设置页选了调色板但没生效」）。
/// "auto" = 跟随主题（前端 terminal-palettes.ts AUTO_PALETTE；没存值与它同义，设置页用它「回到跟随」）
const KNOWN_PALETTES: [&str; 9] = [
    "auto",
    "dark-plus",
    "solarized",
    "one-dark",
    "catppuccin",
    "light-plus",
    "solarized-light",
    "one-light",
    "latte",
];
/// 终端渲染器闭集（terminal_renderer）：auto = WebGL（两个平台同，2026-10-22 起）/ dom = 兼容；
/// webgl 是旧值，与 auto 同义，留着让旧设置读得进来
const KNOWN_RENDERERS: [&str; 3] = ["auto", "dom", "webgl"];
/// 内置终端 shell 闭集（terminal_shell）：两个平台的选项放一张表，跨机同步的设置里留着对方平台的值也不丢
pub(crate) const KNOWN_TERMINAL_SHELLS: [&str; 8] =
    ["auto", "powershell", "pwsh", "git-bash", "cmd", "zsh", "bash", "fish"];
/// 会话页「⇗ 外部恢复」可选的终端应用；auto = 按平台优先级探测
const KNOWN_EXTERNAL_TERMINALS: [&str; 10] = [
    "auto",
    "ghostty",
    "iterm",
    "terminal",
    "powershell",
    "cmd",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
];
const KNOWN_STARTUP_NAV_MODES: [&str; 3] = ["expanded", "collapsed", "hidden"];
/// 顶部岛自动收起延时档位。必须与前端 src/nav-capsule.ts 的 NAV_CAPSULE_DELAYS 一致：
/// 这里是入库存真值的白名单，不在表里的值会被静默落回默认，前端再怎么加选项都不生效。
/// 0 = 立即（指针一离开就收），是合法取值而不是「没设置」——Option 的 None 才表示没设置。
const KNOWN_NAV_CAPSULE_DELAYS_MS: [u32; 5] = [0, 500, 1000, 2000, 5000];
/// 侧栏 / 顶栏罩色的档位（百分比）。**这是各主题自己的罩色基数上的倍率，不是不透明度**：
/// 100 = 各主题本来的样子（深色侧栏 42%、浅色 78%、图标态 28%），0 = 完全不铺罩色、
/// 直接透出壁纸。两端含义在三套基数下一致，中间档则同一档在深浅主题里浓淡不同——
/// 这正是要在 hint 里讲清楚的事，否则用户会以为 50% 在哪都是一半。
///
/// 为什么是挡位表而不是 min/max 钳制：深浅与图标态三套基数不同，能看清侧栏文字的下限
/// 只能一档一档比出来，连续值没有可判断的落点。
/// 为什么允许到 0：亮壁纸上本来就是「想更实」，暗壁纸/照片壁纸才是「想更透」，
/// 只允许单向会让另一半用户没法调。0 有对比度风险，由 hint 讲明，不做硬拦——
/// 这是外观设置，用户看得见自己调坏的样子，也能立刻调回来。
const KNOWN_CHROME_OPACITIES: [u32; 6] = [0, 25, 50, 75, 85, 100];
const KNOWN_NAV_CAPSULE_DISPLAY_MODES: [&str; 3] = ["both", "icons", "labels"];
/// 应用图标外观（设置 → 外观 → 应用图标）：system = 交给打包资源（macOS 26+ 随系统外观），
/// dark / light = 运行中强制换图。只影响运行中的程序坞 / 主窗 / 托盘，见 app_icon.rs
pub(crate) const KNOWN_APP_ICON_STYLES: [&str; 3] = ["system", "dark", "light"];
const DEFAULT_APP_ICON_STYLE: &str = "system";
/// 聊天层阅读体验（设置 → 外观）：字号档、字体、行内代码强调色、滚动条。与前端 chat-style.ts 的表一致；
/// 不在表里的存量值落回默认，前端加选项而这里没跟上会「选了没反应」。
const KNOWN_CHAT_FONT_SIZES: [&str; 4] = ["small", "normal", "large", "xlarge"];
const KNOWN_CHAT_FONT_FAMILIES: [&str; 3] = ["system", "serif", "mono"];
const KNOWN_CHAT_ACCENTS: [&str; 5] = ["off", "warm", "amber", "teal", "violet"];
const KNOWN_CHAT_SCROLLBARS: [&str; 2] = ["auto", "always"];
/// 顶部岛可配入口（与前端 nav-capsule.ts NAV_CAPSULE_ITEM_IDS 同步）；「运行」2026-10-24 起不上岛，存过的读出来丢掉
const KNOWN_NAV_CAPSULE_ITEMS: [&str; 9] = [
    "quick-chat",
    "workbench",
    "sessions",
    "workspaces",
    "profiles",
    "skills",
    "mcp",
    "stats",
    "settings",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomThemeDto {
    pub rail: Option<String>,
    pub canvas: Option<String>,
    pub accent: Option<String>,
}

fn parse_hex_color(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#').to_ascii_lowercase();
    let bytes = h.as_bytes();
    let hex = |b: u8| b.is_ascii_hexdigit();
    match bytes.len() {
        3 if bytes.iter().copied().all(hex) => Some(format!(
            "#{0}{0}{1}{1}{2}{2}",
            bytes[0] as char, bytes[1] as char, bytes[2] as char
        )),
        6 if bytes.iter().copied().all(hex) => Some(format!("#{h}")),
        _ => None,
    }
}

fn sanitize_custom_theme(v: Option<CustomThemeDto>) -> Option<CustomThemeDto> {
    let v = v?;
    Some(CustomThemeDto {
        rail: Some(parse_hex_color(v.rail.as_deref()?)?),
        canvas: Some(parse_hex_color(v.canvas.as_deref()?)?),
        accent: Some(parse_hex_color(v.accent.as_deref()?)?),
    })
}

const CUSTOM_THEME_CARDS_MAX: usize = 12;
const CUSTOM_THEME_CARD_NAME_MAX: usize = 12;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomThemeCardDto {
    pub id: Option<String>,
    pub name: Option<String>,
    pub rail: Option<String>,
    pub canvas: Option<String>,
    pub accent: Option<String>,
}

fn sanitize_card_id(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t.len() > 32 {
        return None;
    }
    if t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Some(t.to_string())
    } else {
        None
    }
}

fn sanitize_card_name(s: &str) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(CUSTOM_THEME_CARD_NAME_MAX).collect();
    if t.is_empty() {
        "色卡".into()
    } else {
        t
    }
}

fn sanitize_custom_theme_cards(
    v: Option<Vec<CustomThemeCardDto>>,
) -> Option<Vec<CustomThemeCardDto>> {
    let v = v?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for c in v {
        let Some(id) = c.id.as_deref().and_then(sanitize_card_id) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(colors) = sanitize_custom_theme(Some(CustomThemeDto {
            rail: c.rail,
            canvas: c.canvas,
            accent: c.accent,
        })) else {
            continue;
        };
        out.push(CustomThemeCardDto {
            id: Some(id),
            name: Some(sanitize_card_name(c.name.as_deref().unwrap_or(""))),
            rail: colors.rail,
            canvas: colors.canvas,
            accent: colors.accent,
        });
        if out.len() >= CUSTOM_THEME_CARDS_MAX {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettingsDto {
    pub terminal_font_size: Option<u16>,
    pub terminal_font_family: Option<String>,
    /// 终端渲染器：auto（默认，Windows 流畅优先 / macOS 清晰优先）| webgl（流畅）| dom（清晰）。
    /// 未知值读时静默丢弃（同 KNOWN_PALETTES 口径）
    pub terminal_renderer: Option<String>,
    /// 内置终端用哪个 shell：auto（默认，Windows = Windows PowerShell，macOS / Linux = $SHELL）|
    /// powershell | pwsh | git-bash | cmd（Windows）| zsh | bash | fish（macOS / Linux）。
    /// 未知值读时回落 auto；选了本机没有的，启动时也回落 auto（pty::login_shell_argv）
    pub terminal_shell: Option<String>,
    /// Windows 上定时任务里的 Codex 开它自己的 Windows 沙箱（非提权）：用户在定时任务弹层或设置里看过说明、点了确认才是 true。
    /// 用户的 Codex 配置里已有 `[windows] sandbox` 时不看这一项（照用户的）。默认 false（命令会被 Codex 拦下）
    pub codex_win_sandbox_consent: Option<bool>,
    /// 终端 16 色调色板预设：dark-plus（默认）| solarized | one-dark | catppuccin
    pub terminal_palette: Option<String>,
    pub scrollback: Option<u32>,
    pub rate_usd_cny: Option<f64>,
    pub brew_mirror: Option<bool>,
    /// 长任务 OS 通知开关（注意力跃迁且窗口未聚焦时发系统通知）
    pub notifications_enabled: Option<bool>,
    /// 会话自动命名开关（设置页「集成」分区，默认开）。关 = 聊完起名（early/final）与
    /// 打开对话页的补名去重（ai_retitle_all_sessions）全停；已有标题保留，
    /// 手改标题（title_source=user）本就不被覆盖，与此开关无关。
    pub auto_title_sessions: Option<bool>,
    /// 出图模型（2026-10-23；2026-10-24 起编辑处在连接页「出图模型」，设置页只显示现状）：网关 id + 模型 id，
    /// Agent 经 `mesa_helper image` 出图时的默认值（image_gen.rs）。两者同进退，空串 = 清空
    pub image_gen_gateway_id: Option<String>,
    pub image_gen_model: Option<String>,
    /// 内部对话保留期自动清理（设置页「数据与存储」，默认开，2026-10-17 用户拍板）。
    /// 只清 Mesa 自己的一次性后台对话，见 internal_sessions.rs
    pub internal_auto_clean: Option<bool>,
    /// 内部对话保留天数（7–365，默认 30）
    pub internal_retention_days: Option<u32>,
    /// 工作副本家目录的自定义基目录（2026-10-18）：实际根是 `<基目录>/ccode`，缺省 = `~/ccode`。
    /// 不走 update_settings patch（merge 不搬运）——只由 set_workspace_root 校验后写入，
    /// 清空也走它（Option 下 null 等价缺失）。语义与曾用根见 ccode_home.rs
    pub workspace_root: Option<String>,
    /// 曾用过的自定义基目录（换位置后旧树还在原处，「是不是 Mesa 自己的」判定要认）
    pub workspace_root_history: Option<Vec<String>>,
    /// 反馈邮箱直发配置（非密钥部分；授权码存 keys.json 键 feedback-smtp，
    /// 由 feedback.rs 的 set_feedback_smtp_secret 管理，绝不进 settings）
    pub feedback_smtp: Option<crate::feedback::FeedbackSmtpConfigDto>,
    /// 界面大小（整页缩放，1.0 = 100%）：档位见前端 ui-zoom.ts，这里只夹到 ui_zoom 的范围；
    /// update_settings 带上它时顺手套到主窗口（连同最小窗口尺寸），开机由 lib.rs setup 先套
    pub ui_zoom: Option<f64>,
    pub theme: Option<String>,
    /// 主题跟随系统深浅（2026-10-17，缺省关）：开着时前端在系统外观变化时把 theme 换成
    /// 同名 twin（xxx ↔ xxx-light）写回，theme 始终是生效值；自定义配色无 twin 不跟随
    pub theme_follow_system: Option<bool>,
    /// 侧栏 / 顶栏罩色透明度（百分比挡位，见 KNOWN_CHROME_OPACITIES）。
    /// 乘在各主题自己的罩色基数上，所以这一个值同时管侧栏和顶栏、深浅两套；
    /// 100 = 各主题原有观感，是默认值，也就是「没调过和以前一模一样」。
    pub chrome_opacity: Option<u32>,
    /// 应用图标外观（KNOWN_APP_ICON_STYLES），缺省 system
    pub app_icon_style: Option<String>,
    /// 聊天层字号档（KNOWN_CHAT_FONT_SIZES），缺省 normal = 不动现有字号
    pub chat_font_size: Option<String>,
    /// 聊天层正文字体（KNOWN_CHAT_FONT_FAMILIES），缺省 system
    pub chat_font_family: Option<String>,
    /// 聊天层行内代码强调色（KNOWN_CHAT_ACCENTS），缺省 warm；off = 中性灰白
    pub chat_accent: Option<String>,
    /// 聊天滚动条（KNOWN_CHAT_SCROLLBARS）：auto = 闲置淡出，always = 常显；缺省 auto
    pub chat_scrollbar: Option<String>,
    /// 自定义主题三色（左栏/画布/强调）。theme 为 custom / custom-light 时由前端派生全套令牌
    pub custom_theme: Option<CustomThemeDto>,
    /// 另存的可点色卡（最多 12 套）
    pub custom_themes: Option<Vec<CustomThemeCardDto>>,
    /// 当前选中的另存色卡 id；不在列表里则读侧清掉
    pub custom_theme_card_id: Option<String>,
    /// ◈ AI 功能（提交信息/摘要/PR 描述）固定使用的 profile id；None = 自动（最近使用）
    pub ai_profile_id: Option<String>,
    /// 专用配置选中的模型。空 = 该配置 models 的第一个。不在该配置列表里时启动侧回落第一个。
    pub ai_model: Option<String>,
    /// ◈ AI 功能按功能独立配置：键 = 功能 key（见 ai.rs FN_* 常量），值 = profile id；
    /// 某功能缺省时回落 ai_profile_id，None = 全部走默认
    pub ai_profiles: Option<BTreeMap<String, String>>,
    /// 与 ai_profiles 同键的模型。键不在 ai_profiles 里的丢弃；空值丢弃。
    pub ai_profile_models: Option<BTreeMap<String, String>>,
    /// 每个 agent 的默认 profile（agent id → profile id）：终端启动栏选完 agent 后预选它。
    /// 解析顺序 显式默认 > ccode.lastProfile（上次使用）> 该 agent 首个配置。
    /// 键缺失 = 没设默认，整图覆盖（同 ai_profiles 口径）。
    /// 刻意不在 profiles.json 加 `enabled` 布尔：配置是**启动那一刻**注入的，
    /// 没有「全局激活态」，加 enabled 会与注入语义打架、也会和「设为全局」形成两套激活概念。
    pub default_profiles: Option<BTreeMap<String, String>>,
    /// 启动时进入哪一页（页面 id，同 hotkeys.ts PAGE_HOTKEY_DEFS）；缺省 = workbench
    pub start_page: Option<String>,
    /// 启动时的导航形态；缺省时前端尊重旧 navCollapsed 偏好
    pub startup_nav_mode: Option<String>,
    /// 顶部导航胶囊离开后的自动隐藏延迟（毫秒）
    pub nav_capsule_hide_delay_ms: Option<u32>,
    /// 顶部导航胶囊内容显示：both（符号+文字）/icons（仅符号）/labels（仅文字）
    pub nav_capsule_display_mode: Option<String>,
    /// 顶部导航胶囊中显示的入口 id；缺省 = 全部显示
    pub nav_capsule_visible_items: Option<Vec<String>>,
    /// 顶部岛的跑完/跑挂播报开关。
    /// 关掉不影响系统通知与收件箱——那两条各自独立，这里只管岛上那一行字。
    pub nav_capsule_run_announce: Option<bool>,
    /// 「停用」的 profile id 列表（字段名沿用旧称 hidden_profiles，不改存储）：软停用 =
    /// 不被自动路径挑中（启动栏预选/兜底、恢复会话 pickResumeProfile、AI 功能最近使用回落），
    /// 手动指定仍可用。**不删数据、不改任何启动行为**——已选中它的标签照常工作，配置页照常列出。
    /// 存在设置里而不是 profiles.json：这是使用偏好，不是配置属性。
    pub hidden_profiles: Option<Vec<String>>,
    /// 「设为全局」追踪：agent id → 上次由 Mesa 成功写入该 agent 全局配置的 profile id。
    /// apply_profile_global 写成功后记录，restore_global_backup 后清除（恢复后全局内容
    /// 不再是任何 profile 的快照）。只代表「上次由 Mesa 写入」，不是绝对生效态——
    /// 在 Mesa 之外手改配置文件会失真，UI 文案照此口径（「全局生效」徽标 title 已注明）。
    /// 由 record_active_global/clear_active_global 维护，不走 update_settings patch
    pub active_global_profiles: Option<BTreeMap<String, String>>,
    /// 「设为全局」的 cc-switch 提醒已确认过、以后一键切换不再提醒的 agent（2026-10-28 用户：每次写都弹太麻烦）。
    /// 只管一键切换（连接行地球图标、托盘）；⋯ 菜单里的「写入 CLI 全局默认…」仍先预览并照常提醒
    pub global_conflict_ack: Option<Vec<String>>,
    /// 会话页「⇗ 外部恢复」使用的终端应用（KNOWN_EXTERNAL_TERMINALS）；None/auto = 自动探测
    pub external_terminal: Option<String>,
    /// 精确注意力标记（agent hooks 桥接）：agent id → 开关。键缺失 = 关。
    /// 开/关由 hooks::set_hooks_attention 统一完成（写各家 hooks 配置 + 逐键记本字段），勿单独 patch
    pub hooks_attention: Option<BTreeMap<String, bool>>,
    /// 旧字段（Claude 单开关时代）：仅保留反序列化兼容，读取侧迁移进 hooks_attention（见
    /// with_defaults / set_hooks_attention_entry），不再写出
    #[serde(skip_serializing)]
    pub claude_hooks_attention: Option<bool>,
    /// 快捷键绑定（"mod+shift+k" 格式，mod=⌘/Ctrl；空串 = 禁用该快捷键）
    pub hotkey_palette: Option<String>,
    pub hotkey_hide_chrome: Option<String>,
    pub hotkey_new_chat: Option<String>,
    pub hotkey_focus_rail: Option<String>,
    pub hotkey_toggle_surface: Option<String>,
    pub hotkey_new_project: Option<String>,
    pub hotkey_rail_search: Option<String>,
    /// ⌘1–⌘9 页切整组总开关（关 = 全部页切绑定不生效）
    pub hotkey_page_switch: Option<bool>,
    /// 页切逐页绑定：键 = 页面 id（前端 hotkeys.ts PAGE_HOTKEY_DEFS），值 = 组合串；
    /// 键缺失 = 该页用默认绑定（mod+1..mod+9），整图覆盖（同 ai_profiles 口径）
    pub hotkey_pages: Option<BTreeMap<String, String>>,
    /// 底部状态栏统一开关（终端层与聊天层同进退，默认开）。关 = 两层都不渲染，
    /// 切层不改终端行列数（两层一致无需占位）；旧字段 status_bar_in_chat=false 自动迁移为关
    pub status_bar: Option<bool>,
    /// 已废弃（2026-09-19）：仅保留读取迁移——statusBarInChat=false 老用户保持关闭；
    /// 前端不再写此字段，生效值一律看 status_bar
    pub status_bar_in_chat: Option<bool>,
    /// 打开对话时先显示哪一层（2026-10-22）："chat" / "terminal"，缺省与未知值 = chat。
    /// 问 AI、开始、商量、继续、接着聊、精读等进入 Agent 对话的入口都跟它走；
    /// 「新对话」固定聊天，登录 / 脚本 / MCP 登录等没有对话可看的固定终端（前端 tab-surface.ts）
    pub open_surface: Option<String>,
    /// 向 agent 主动告知终端底色（Windows 专用，默认开）。ConPTY 双向都不转发
    /// OSC 10/11 底色查询——子进程的查询到不了 xterm，回报也回不去子进程——
    /// 浅色主题下 agent 探不到底色就回落深色配色（输入框变深灰）。开 = attach 后
    /// 把当前主题前景/底色编码成 win32-input-mode 按键记录推给 agent。
    /// 只推给会消费这个回报的 agent（前端 TERMINAL_BG_PROBING_AGENTS 白名单：
    /// 目前 gemini / qwen）——推给不探测的 agent 会漏成输入框乱码，codex 实测如此。
    pub terminal_color_report: Option<bool>,
    /// 出网代理 URL（官方账号启动与组头登录注入 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）。
    /// 空/缺省 = 不注入。网关 API 启动不走这条（国内中转被全局代理绕路常挂）。
    /// 连接 extra_env 同名键排在后面覆盖。
    pub outbound_proxy: Option<String>,
    /// 所有连接共用的环境变量（2026-10-28）：Mesa 启动每家 Agent 时都带上（官方账号也带），连接自己的附加环境变量
    /// 同名时覆盖它。只放和连接无关的设置（关遥测、调日志之类）；密钥、地址、模型、代理、终端相关的键拒收
    /// （`shared_env_rejection`）——设置文件不是 0600 的密钥库
    pub shared_env: Option<BTreeMap<String, String>>,
    /// NO_PROXY；出网代理有值且此项空时默认 localhost,127.0.0.1,::1
    pub outbound_no_proxy: Option<String>,
    /// 机构访问前缀（EZproxy/OpenAthens 式，如 https://proxy.xxx.edu.cn/login?url=）：
    /// 仅用于文献全文获取通道的 URL 改写与登录窗起始页。空 = 未配置。
    /// 非密钥（登录会话 Cookie 另存 0600 inst-session.json，见 inst_access.rs）
    pub institutional_prefix: Option<String>,
    /// 机构登录窗上次打开的地址（学校图书馆/CARSI 入口或代理登录页），便于一键重开；非密钥
    pub institutional_login_url: Option<String>,
}

pub const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// 出网代理须是 http(s) / socks 地址。空串视为未配置。
pub fn validate_outbound_proxy(raw: &str) -> Result<(), String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(());
    }
    let lower = t.to_ascii_lowercase();
    let ok_scheme = [
        "http://",
        "https://",
        "socks5://",
        "socks5h://",
        "socks4://",
    ]
    .iter()
    .any(|s| lower.starts_with(s));
    if !ok_scheme {
        return Err("出网代理须是 http(s):// 或 socks5:// 地址，例如 http://127.0.0.1:7890".into());
    }
    let after = t.splitn(2, "://").nth(1).unwrap_or("");
    let hostport = after.split('/').next().unwrap_or("");
    let host = hostport.rsplit('@').next().unwrap_or("");
    if host.is_empty() || host.starts_with(':') {
        return Err("出网代理缺少主机".into());
    }
    Ok(())
}

/// 由设置算出官方账号要注入的代理 env（不含 extra_env 覆盖）。
pub fn official_outbound_env_from(s: &AppSettingsDto) -> Vec<(String, String)> {
    let Some(proxy) = s
        .outbound_proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Vec::new();
    };
    if validate_outbound_proxy(proxy).is_err() {
        return Vec::new();
    }
    let no_proxy = s
        .outbound_no_proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_NO_PROXY);
    vec![
        ("HTTPS_PROXY".into(), proxy.to_string()),
        ("HTTP_PROXY".into(), proxy.to_string()),
        ("ALL_PROXY".into(), proxy.to_string()),
        ("NO_PROXY".into(), no_proxy.to_string()),
    ]
}

/// 生产路径读 settings.json；单测不读本机文件（避免用户代理污染官方启动断言）。
pub fn official_outbound_env() -> Vec<(String, String)> {
    if cfg!(test) {
        return Vec::new();
    }
    official_outbound_env_from(&read_current())
}

/// 下载侧（agent 安装/更新、依赖安装、字体、更新检查）注入的代理 env：与官方账号
/// 启动同源 outbound_proxy，但大小写都写（curl 的 http_proxy 只认小写，npm 两者都认）；
/// extra_no_proxy（国内镜像主机）并入 NO_PROXY 直连——镜像走代理绕道境外反而慢。
pub fn download_proxy_env_from(
    s: &AppSettingsDto,
    extra_no_proxy: &[&str],
) -> Vec<(String, String)> {
    let Some(proxy) = s
        .outbound_proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Vec::new();
    };
    if validate_outbound_proxy(proxy).is_err() {
        return Vec::new();
    }
    let mut no_proxy = s
        .outbound_no_proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_NO_PROXY)
        .to_string();
    for host in extra_no_proxy {
        let h = host.trim();
        if h.is_empty() || no_proxy.split(',').any(|e| e.trim() == h) {
            continue;
        }
        if !no_proxy.is_empty() {
            no_proxy.push(',');
        }
        no_proxy.push_str(h);
    }
    [
        ("http_proxy", proxy),
        ("HTTP_PROXY", proxy),
        ("https_proxy", proxy),
        ("HTTPS_PROXY", proxy),
        ("all_proxy", proxy),
        ("ALL_PROXY", proxy),
        ("no_proxy", no_proxy.as_str()),
        ("NO_PROXY", no_proxy.as_str()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// 生产路径：用户环境已自带任一代理变量（终端手 export 后拉起 Mesa 的场景）时不覆盖；
/// 单测返回空（避免本机代理污染 PTY/子进程断言）。
pub fn download_proxy_env(extra_no_proxy: &[&str]) -> Vec<(String, String)> {
    if cfg!(test) {
        return Vec::new();
    }
    for key in [
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ] {
        if std::env::var_os(key).is_some_and(|v| !v.to_string_lossy().trim().is_empty()) {
            return Vec::new();
        }
    }
    download_proxy_env_from(&read_current(), extra_no_proxy)
}

// ===== 出网代理自动检测（2026-09-16）=====
// 候选来源：系统代理设置（macOS scutil / Windows 注册表 / Linux gsettings，均走
// background_command）→ 环境变量 → 本机常见代理端口 TCP 探测。只做「检测出来供人
// 点选」，不静默改写设置——填不填、用哪个仍由用户拍板（同会话里机构访问的口径）。

/// 检测候选：完整代理 URL + 来源说明 + 端口是否活着（TCP 探测）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboundProxyCandidateDto {
    pub url: String,
    pub source: String,
    pub alive: bool,
}

/// 常见本机代理端口（国内主流客户端默认值）：is_http=false 的按 socks5 出 URL
const COMMON_PROXY_PORTS: &[(u16, bool, &str)] = &[
    (7890, true, "Clash 混合端口"),
    (7897, true, "Clash Verge 默认混合端口"),
    (10809, true, "V2RayN HTTP"),
    (8118, true, "Privoxy"),
    (6152, true, "Surge HTTP"),
    (1080, false, "SOCKS 常用端口"),
];

/// TCP 探测代理端口是否在监听（400ms；host:port 解析失败按不在线处理）
fn proxy_url_alive(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let (Some(host), Some(port)) = (parsed.host_str(), parsed.port_or_known_default()) else {
        return false;
    };
    use std::net::ToSocketAddrs as _;
    let Ok(mut addrs) = format!("{host}:{port}").to_socket_addrs() else {
        return false;
    };
    addrs
        .next()
        .and_then(|addr| {
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).ok()
        })
        .is_some()
}

/// 环境变量值归一成代理 URL：没带 scheme 的补 http://（ socks5: 前缀已带 scheme 的原样）
fn normalize_proxy_env_value(value: &str) -> String {
    let t = value.trim();
    if t.is_empty() || t.contains("://") {
        return t.to_string();
    }
    format!("http://{t}")
}

/// macOS scutil --proxy 输出解析：HTTPEnable/HTTPProxy/HTTPPort、HTTPS 同款、SOCKS 同款，
/// 启用（Enable : 1）才产出。纯函数供单测。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil_proxy(text: &str) -> Vec<String> {
    let get = |key: &str| -> Option<String> {
        text.lines()
            .map(str::trim)
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().to_string())
    };
    let mut out = Vec::new();
    for (enable_key, host_key, port_key, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "https"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ] {
        if get(enable_key).as_deref() != Some("1") {
            continue;
        }
        if let (Some(host), Some(port)) = (get(host_key), get(port_key)) {
            if !host.is_empty() && !port.is_empty() {
                out.push(format!("{scheme}://{host}:{port}"));
            }
        }
    }
    out
}

/// Windows 注册表 ProxyEnable/ProxyServer 解析（reg query 输出）。ProxyServer 形如
/// `127.0.0.1:7890` 或 `http=x:y;https=x:y;socks=x:y`。纯函数供单测。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_reg_proxy(text: &str) -> Vec<String> {
    let value_of = |name: &str| -> Option<String> {
        text.lines()
            .map(str::trim)
            .find(|l| l.starts_with(name) && l.contains("REG_"))
            .and_then(|l| l.rsplit(|c: char| c.is_whitespace()).next())
            .map(str::to_string)
    };
    if value_of("ProxyEnable").as_deref() != Some("0x1") {
        return Vec::new();
    }
    let Some(server) = value_of("ProxyServer") else {
        return Vec::new();
    };
    if server.contains('=') {
        // 分协议形式：优先 https，其次 http，再 socks
        let seg = |k: &str| {
            server
                .split(';')
                .find_map(|s| s.trim().strip_prefix(&format!("{k}=")))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        for k in ["https", "http", "socks"] {
            if let Some(v) = seg(k) {
                let scheme = if k == "socks" { "socks5" } else { k };
                return vec![format!("{scheme}://{v}")];
            }
        }
        Vec::new()
    } else if !server.is_empty() {
        vec![format!("http://{server}")]
    } else {
        Vec::new()
    }
}

/// Linux GNOME 代理（gsettings manual 模式）：https 优先，回落 http；读不到返回空
#[cfg(target_os = "linux")]
fn gsettings_proxy() -> Vec<String> {
    let run = |schema: &str, key: &str| -> Option<String> {
        let out = crate::process::background_command("gsettings")
            .args(["get", schema, key])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .trim_matches('\'')
                .to_string(),
        )
    };
    if run("org.gnome.system.proxy", "mode").as_deref() != Some("manual") {
        return Vec::new();
    }
    let mut out = Vec::new();
    for schema in ["https", "http"] {
        let (Some(host), Some(port)) = (
            run(&format!("org.gnome.system.proxy.{schema}"), "host"),
            run(&format!("org.gnome.system.proxy.{schema}"), "port"),
        ) else {
            continue;
        };
        if !host.is_empty() && port.parse::<u16>().is_ok() {
            out.push(format!("{schema}://{host}:{port}"));
        }
    }
    out
}

fn detect_outbound_proxy_inner() -> Result<Vec<OutboundProxyCandidateDto>, String> {
    let mut urls: Vec<(String, String)> = Vec::new(); // (url, source)
                                                      // 1) 系统代理设置
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = crate::process::background_command("scutil")
            .arg("--proxy")
            .output()
        {
            if out.status.success() {
                for url in parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout)) {
                    urls.push((url, "系统代理".into()));
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::process::background_command("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ])
            .output()
        {
            if out.status.success() {
                for url in parse_windows_reg_proxy(&String::from_utf8_lossy(&out.stdout)) {
                    urls.push((url, "系统代理".into()));
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    for url in gsettings_proxy() {
        urls.push((url, "系统代理（GNOME）".into()));
    }
    // 2) 环境变量（GUI 启动常拿不到 shell 的，但终端里起 Mesa 的场景有值）
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(v) = std::env::var(key) {
            let url = normalize_proxy_env_value(&v);
            if !url.is_empty() {
                urls.push((url, format!("环境变量 {key}")));
            }
        }
    }
    // 3) 本机常见代理端口：只有探测到在监听才列（不摆死端口）
    for (port, is_http, hint) in COMMON_PROXY_PORTS {
        let scheme = if *is_http { "http" } else { "socks5" };
        let url = format!("{scheme}://127.0.0.1:{port}");
        if proxy_url_alive(&url) {
            urls.push((url, format!("本机端口 · {hint}")));
        }
    }
    // 去重（同 URL 保留首个来源），统一补 TCP 活性
    let mut out: Vec<OutboundProxyCandidateDto> = Vec::new();
    for (url, source) in urls {
        if out.iter().any(|c| c.url == url) {
            continue;
        }
        let alive = proxy_url_alive(&url);
        out.push(OutboundProxyCandidateDto { url, source, alive });
    }
    Ok(out)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("settings.json"))
}

/// 缺失用默认；损坏/不可读必须保留原件，禁止下一次保存静默重置。
fn read_checked(path: &Path) -> Result<AppSettingsDto, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "设置文件损坏，原文件已保留，请修复后重试：{}：{e}",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppSettingsDto::default()),
        Err(e) => Err(format!("读取设置失败：{e}")),
    }
}
fn read_from(path: &Path) -> AppSettingsDto {
    match read_checked(path) {
        Ok(settings) => settings,
        Err(error) => {
            crate::logbuf::record("error", "settings", &error);
            AppSettingsDto::default()
        }
    }
}

fn write_to(path: &Path, settings: &AppSettingsDto) -> Result<(), String> {
    read_checked(path)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 模型选择必须挂在还存在的功能配置上；专用配置清空时模型一并去掉。
fn prune_ai_model_choice(settings: &mut AppSettingsDto) {
    if settings.ai_profile_id.is_none() {
        settings.ai_model = None;
    }
    let Some(mut models) = settings.ai_profile_models.take() else {
        return;
    };
    let profiles = settings.ai_profiles.as_ref();
    models.retain(|key, model| {
        !model.trim().is_empty() && profiles.is_some_and(|map| map.contains_key(key))
    });
    if !models.is_empty() {
        settings.ai_profile_models = Some(models);
    }
}

/// 白名单取值：不在表里（存量脏值 / 前端先于后端加选项）一律落回默认
fn known_or(v: Option<String>, table: &[&str], default: &str) -> String {
    v.filter(|x| table.contains(&x.as_str()))
        .unwrap_or_else(|| default.to_string())
}

/// 合并默认值：get_settings 永远返回完整对象；未知 theme 值回落默认
fn with_defaults(s: AppSettingsDto) -> AppSettingsDto {
    let custom_theme = sanitize_custom_theme(s.custom_theme);
    let custom_themes = sanitize_custom_theme_cards(s.custom_themes);
    let custom_theme_card_id = s.custom_theme_card_id.filter(|id| {
        custom_themes
            .as_ref()
            .is_some_and(|cs| cs.iter().any(|c| c.id.as_deref() == Some(id.as_str())))
    });
    let theme = {
        let t = s.theme.filter(|t| KNOWN_THEMES.contains(&t.as_str()));
        match t.as_deref() {
            Some("custom" | "custom-light") if custom_theme.is_none() => DEFAULT_THEME.to_string(),
            Some(v) => v.to_string(),
            None => DEFAULT_THEME.to_string(),
        }
    };
    let mut out = AppSettingsDto {
        terminal_font_size: s.terminal_font_size.or(Some(DEFAULT_TERMINAL_FONT_SIZE)),
        terminal_font_family: s
            .terminal_font_family
            .or_else(|| Some(DEFAULT_TERMINAL_FONT_FAMILY.to_string())),
        terminal_renderer: s
            .terminal_renderer
            .filter(|r| KNOWN_RENDERERS.contains(&r.as_str())),
        terminal_shell: Some(
            s.terminal_shell
                .filter(|v| KNOWN_TERMINAL_SHELLS.contains(&v.as_str()))
                .unwrap_or_else(|| "auto".into()),
        ),
        codex_win_sandbox_consent: Some(s.codex_win_sandbox_consent.unwrap_or(false)),
        terminal_palette: s
            .terminal_palette
            .filter(|p| KNOWN_PALETTES.contains(&p.as_str())),
        scrollback: s.scrollback.or(Some(DEFAULT_SCROLLBACK)),
        rate_usd_cny: s.rate_usd_cny.or(Some(DEFAULT_RATE_USD_CNY)),
        brew_mirror: s.brew_mirror.or(Some(DEFAULT_BREW_MIRROR)),
        notifications_enabled: s
            .notifications_enabled
            .or(Some(DEFAULT_NOTIFICATIONS_ENABLED)),
        auto_title_sessions: s
            .auto_title_sessions
            .or(Some(DEFAULT_AUTO_TITLE_SESSIONS)),
        image_gen_gateway_id: s.image_gen_gateway_id.filter(|v| !v.trim().is_empty()),
        image_gen_model: s.image_gen_model.filter(|v| !v.trim().is_empty()),
        internal_auto_clean: s.internal_auto_clean.or(Some(true)),
        internal_retention_days: Some(
            s.internal_retention_days
                .filter(|d| (7..=365).contains(d))
                .unwrap_or(crate::internal_sessions::DEFAULT_RETENTION_DAYS),
        ),
        feedback_smtp: s.feedback_smtp,
        ui_zoom: Some(crate::ui_zoom::clamp_zoom(
            s.ui_zoom.unwrap_or(crate::ui_zoom::DEFAULT_ZOOM),
        )),
        theme: Some(theme),
        chrome_opacity: Some(
            s.chrome_opacity
                .filter(|pct| KNOWN_CHROME_OPACITIES.contains(pct))
                .unwrap_or(DEFAULT_CHROME_OPACITY),
        ),
        app_icon_style: Some(
            s.app_icon_style
                .filter(|v| KNOWN_APP_ICON_STYLES.contains(&v.as_str()))
                .unwrap_or_else(|| DEFAULT_APP_ICON_STYLE.to_string()),
        ),
        chat_font_size: Some(known_or(s.chat_font_size, &KNOWN_CHAT_FONT_SIZES, "normal")),
        chat_font_family: Some(known_or(
            s.chat_font_family,
            &KNOWN_CHAT_FONT_FAMILIES,
            "system",
        )),
        chat_accent: Some(known_or(s.chat_accent, &KNOWN_CHAT_ACCENTS, "warm")),
        chat_scrollbar: Some(known_or(s.chat_scrollbar, &KNOWN_CHAT_SCROLLBARS, "auto")),
        theme_follow_system: Some(s.theme_follow_system.unwrap_or(DEFAULT_THEME_FOLLOW_SYSTEM)),
        custom_theme,
        custom_themes,
        custom_theme_card_id,
        ai_profile_id: s.ai_profile_id.filter(|v| !v.trim().is_empty()),
        ai_model: s.ai_model.filter(|v| !v.trim().is_empty()),
        // 按功能配置不做默认值填充：键缺失即「跟随默认」
        ai_profiles: s.ai_profiles,
        ai_profile_models: s.ai_profile_models,
        default_profiles: s.default_profiles,
        start_page: s.start_page.filter(|p| KNOWN_START_PAGES.contains(&p.as_str())),
        startup_nav_mode: s
            .startup_nav_mode
            .filter(|m| KNOWN_STARTUP_NAV_MODES.contains(&m.as_str())),
        nav_capsule_hide_delay_ms: Some(
            s.nav_capsule_hide_delay_ms
                .filter(|delay| KNOWN_NAV_CAPSULE_DELAYS_MS.contains(delay))
                .unwrap_or(DEFAULT_NAV_CAPSULE_HIDE_DELAY_MS),
        ),
        nav_capsule_display_mode: s
            .nav_capsule_display_mode
            .filter(|mode| KNOWN_NAV_CAPSULE_DISPLAY_MODES.contains(&mode.as_str())),
        nav_capsule_visible_items: s.nav_capsule_visible_items.map(|items| {
            items
                .into_iter()
                .filter(|id| KNOWN_NAV_CAPSULE_ITEMS.contains(&id.as_str()))
                .collect()
        }),
        nav_capsule_run_announce: s
            .nav_capsule_run_announce
            .or(Some(DEFAULT_NAV_CAPSULE_RUN_ANNOUNCE)),
        hidden_profiles: s.hidden_profiles,
        // 后端维护的「设为全局」追踪：原样透传，不做默认值填充
        active_global_profiles: s.active_global_profiles,
        global_conflict_ack: s.global_conflict_ack,
        shared_env: s.shared_env,
        external_terminal: Some({
            let v = s.external_terminal.as_deref().unwrap_or("auto");
            if KNOWN_EXTERNAL_TERMINALS.contains(&v) {
                v.to_string()
            } else {
                "auto".into()
            }
        }),
        // 旧字段迁移：claude_hooks_attention=true 且新 map 无 claude-code 键 → 视为开
        hooks_attention: Some({
            let mut map = s.hooks_attention.unwrap_or_default();
            if s.claude_hooks_attention == Some(true) && !map.contains_key("claude-code") {
                map.insert("claude-code".to_string(), true);
            }
            map
        }),
        // 旧字段原样随行（不再写出，仅内存保留供迁移判断）
        claude_hooks_attention: s.claude_hooks_attention,
        hotkey_palette: s
            .hotkey_palette
            .or_else(|| Some(DEFAULT_HOTKEY_PALETTE.to_string())),
        hotkey_hide_chrome: s
            .hotkey_hide_chrome
            .or_else(|| Some(DEFAULT_HOTKEY_HIDE_CHROME.to_string())),
        hotkey_new_chat: s
            .hotkey_new_chat
            .or_else(|| Some(DEFAULT_HOTKEY_NEW_CHAT.to_string())),
        hotkey_focus_rail: s
            .hotkey_focus_rail
            .or_else(|| Some(DEFAULT_HOTKEY_FOCUS_RAIL.to_string())),
        hotkey_toggle_surface: s
            .hotkey_toggle_surface
            .or_else(|| Some(DEFAULT_HOTKEY_TOGGLE_SURFACE.to_string())),
        hotkey_new_project: s
            .hotkey_new_project
            .or_else(|| Some(DEFAULT_HOTKEY_NEW_PROJECT.to_string())),
        hotkey_rail_search: s
            .hotkey_rail_search
            .or_else(|| Some(DEFAULT_HOTKEY_RAIL_SEARCH.to_string())),
        hotkey_page_switch: s.hotkey_page_switch.or(Some(DEFAULT_HOTKEY_PAGE_SWITCH)),
        // 逐页绑定不做默认值填充：键缺失即「跟随默认」（同 ai_profiles 口径）
        hotkey_pages: s.hotkey_pages,
        status_bar: Some(s.status_bar.or(s.status_bar_in_chat).unwrap_or(true)),
        status_bar_in_chat: s.status_bar_in_chat.or(Some(true)),
        open_surface: Some(
            if s.open_surface.as_deref() == Some("terminal") { "terminal" } else { "chat" }.into(),
        ),
        terminal_color_report: s.terminal_color_report.or(Some(true)),
        outbound_proxy: s.outbound_proxy.filter(|v| !v.trim().is_empty()),
        outbound_no_proxy: s.outbound_no_proxy.filter(|v| !v.trim().is_empty()),
        institutional_prefix: s.institutional_prefix.filter(|v| !v.trim().is_empty()),
        institutional_login_url: s.institutional_login_url.filter(|v| !v.trim().is_empty()),
        workspace_root: s.workspace_root.filter(|v| !v.trim().is_empty()),
        workspace_root_history: s.workspace_root_history.filter(|v| !v.is_empty()),
    };
    prune_ai_model_choice(&mut out);
    out
}

/// patch 语义：只覆盖传入的 Some 字段
fn merge(cur: &mut AppSettingsDto, patch: AppSettingsDto) {
    if patch.terminal_font_size.is_some() {
        cur.terminal_font_size = patch.terminal_font_size;
    }
    if patch.terminal_font_family.is_some() {
        cur.terminal_font_family = patch.terminal_font_family;
    }
    if patch.terminal_renderer.is_some() {
        cur.terminal_renderer = patch.terminal_renderer;
    }
    if patch.terminal_shell.is_some() {
        cur.terminal_shell = patch.terminal_shell;
    }
    if patch.codex_win_sandbox_consent.is_some() {
        cur.codex_win_sandbox_consent = patch.codex_win_sandbox_consent;
    }
    if patch.terminal_palette.is_some() {
        cur.terminal_palette = patch.terminal_palette;
    }
    if patch.scrollback.is_some() {
        cur.scrollback = patch.scrollback;
    }
    if patch.rate_usd_cny.is_some() {
        cur.rate_usd_cny = patch.rate_usd_cny;
    }
    if patch.brew_mirror.is_some() {
        cur.brew_mirror = patch.brew_mirror;
    }
    if patch.notifications_enabled.is_some() {
        cur.notifications_enabled = patch.notifications_enabled;
    }
    if patch.auto_title_sessions.is_some() {
        cur.auto_title_sessions = patch.auto_title_sessions;
    }
    // 出图模型：网关与模型同进退，任一传空串 = 两个一起清空
    if patch.image_gen_gateway_id.is_some() || patch.image_gen_model.is_some() {
        let gw = patch.image_gen_gateway_id.filter(|v| !v.trim().is_empty());
        let model = patch.image_gen_model.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if gw.is_some() && model.is_some() {
            cur.image_gen_gateway_id = gw;
            cur.image_gen_model = model;
        } else {
            cur.image_gen_gateway_id = None;
            cur.image_gen_model = None;
        }
    }
    if patch.internal_auto_clean.is_some() {
        cur.internal_auto_clean = patch.internal_auto_clean;
    }
    if patch.internal_retention_days.is_some() {
        cur.internal_retention_days = patch.internal_retention_days;
    }
    // 反馈邮箱直发配置（校验在 update_settings 入口做，merge 只搬运）。
    // 清空不走这里——Option<T> 下 null 等价于字段缺失，清除有专用命令
    if patch.feedback_smtp.is_some() {
        cur.feedback_smtp = patch.feedback_smtp;
    }
    if let Some(z) = patch.ui_zoom {
        cur.ui_zoom = Some(crate::ui_zoom::clamp_zoom(z));
    }
    if patch.theme.is_some() {
        cur.theme = patch.theme;
    }
    if patch.custom_theme.is_some() {
        cur.custom_theme = sanitize_custom_theme(patch.custom_theme);
    }
    if patch.custom_themes.is_some() {
        cur.custom_themes = sanitize_custom_theme_cards(patch.custom_themes);
    }
    if patch.custom_theme_card_id.is_some() {
        cur.custom_theme_card_id = patch
            .custom_theme_card_id
            .filter(|id| !id.trim().is_empty());
    }
    // 支持清空：传空字符串 → None（回到「自动=最近使用」）
    if patch.ai_profile_id.is_some() {
        cur.ai_profile_id = patch.ai_profile_id.filter(|v| !v.trim().is_empty());
    }
    if patch.ai_model.is_some() {
        cur.ai_model = patch.ai_model.filter(|v| !v.trim().is_empty());
    }
    // 按功能配置整图覆盖（前端每次提交完整 map；空 map = 全部跟随默认）
    if patch.chrome_opacity.is_some() {
        cur.chrome_opacity = patch.chrome_opacity;
    }
    if patch.app_icon_style.is_some() {
        cur.app_icon_style = patch.app_icon_style;
    }
    if patch.chat_font_size.is_some() {
        cur.chat_font_size = patch.chat_font_size;
    }
    if patch.chat_font_family.is_some() {
        cur.chat_font_family = patch.chat_font_family;
    }
    if patch.chat_accent.is_some() {
        cur.chat_accent = patch.chat_accent;
    }
    if patch.chat_scrollbar.is_some() {
        cur.chat_scrollbar = patch.chat_scrollbar;
    }
    if patch.theme_follow_system.is_some() {
        cur.theme_follow_system = patch.theme_follow_system;
    }
    if patch.start_page.is_some() {
        cur.start_page = patch.start_page;
    }
    if patch.startup_nav_mode.is_some() {
        cur.startup_nav_mode = patch.startup_nav_mode;
    }
    if patch.nav_capsule_hide_delay_ms.is_some() {
        cur.nav_capsule_hide_delay_ms = patch.nav_capsule_hide_delay_ms;
    }
    if patch.nav_capsule_display_mode.is_some() {
        cur.nav_capsule_display_mode = patch.nav_capsule_display_mode;
    }
    if patch.nav_capsule_visible_items.is_some() {
        cur.nav_capsule_visible_items = patch.nav_capsule_visible_items;
    }
    if patch.nav_capsule_run_announce.is_some() {
        cur.nav_capsule_run_announce = patch.nav_capsule_run_announce;
    }
    if patch.hidden_profiles.is_some() {
        cur.hidden_profiles = patch.hidden_profiles;
    }
    if patch.global_conflict_ack.is_some() {
        cur.global_conflict_ack = patch.global_conflict_ack;
    }
    if patch.default_profiles.is_some() {
        cur.default_profiles = patch.default_profiles;
    }
    if patch.ai_profiles.is_some() {
        cur.ai_profiles = patch.ai_profiles;
    }
    if patch.ai_profile_models.is_some() {
        cur.ai_profile_models = patch.ai_profile_models;
    }
    if patch.external_terminal.is_some() {
        cur.external_terminal = patch.external_terminal;
    }
    // 整图覆盖（同 ai_profiles 口径）；开/关走 hooks::set_hooks_attention 专用命令
    // （那边用 set_hooks_attention_entry 逐键读-改-写），勿单独 patch 本字段
    if patch.hooks_attention.is_some() {
        cur.hooks_attention = patch.hooks_attention;
    }
    // 旧字段 claude_hooks_attention 不再接受 patch（只读迁移用）
    // 快捷键：Some 即覆盖（含空串=禁用）；读侧 with_defaults 只填 None
    if patch.hotkey_palette.is_some() {
        cur.hotkey_palette = patch.hotkey_palette;
    }
    if patch.hotkey_hide_chrome.is_some() {
        cur.hotkey_hide_chrome = patch.hotkey_hide_chrome;
    }
    if patch.hotkey_new_chat.is_some() {
        cur.hotkey_new_chat = patch.hotkey_new_chat;
    }
    if patch.hotkey_focus_rail.is_some() {
        cur.hotkey_focus_rail = patch.hotkey_focus_rail;
    }
    if patch.hotkey_toggle_surface.is_some() {
        cur.hotkey_toggle_surface = patch.hotkey_toggle_surface;
    }
    if patch.hotkey_new_project.is_some() {
        cur.hotkey_new_project = patch.hotkey_new_project;
    }
    if patch.hotkey_rail_search.is_some() {
        cur.hotkey_rail_search = patch.hotkey_rail_search;
    }
    if patch.hotkey_page_switch.is_some() {
        cur.hotkey_page_switch = patch.hotkey_page_switch;
    }
    // 逐页绑定整图覆盖（前端每次提交完整 map）
    if patch.hotkey_pages.is_some() {
        cur.hotkey_pages = patch.hotkey_pages;
    }
    if patch.status_bar.is_some() {
        cur.status_bar = patch.status_bar;
    }
    if patch.open_surface.is_some() {
        cur.open_surface = patch.open_surface;
    }
    if patch.status_bar_in_chat.is_some() {
        cur.status_bar_in_chat = patch.status_bar_in_chat;
    }
    if patch.terminal_color_report.is_some() {
        cur.terminal_color_report = patch.terminal_color_report;
    }
    if patch.outbound_proxy.is_some() {
        cur.outbound_proxy = patch.outbound_proxy.filter(|v| !v.trim().is_empty());
    }
    if patch.shared_env.is_some() {
        cur.shared_env = patch.shared_env.filter(|m| !m.is_empty());
    }
    if patch.outbound_no_proxy.is_some() {
        cur.outbound_no_proxy = patch.outbound_no_proxy.filter(|v| !v.trim().is_empty());
    }
    if patch.institutional_prefix.is_some() {
        cur.institutional_prefix = patch.institutional_prefix.filter(|v| !v.trim().is_empty());
    }
    if patch.institutional_login_url.is_some() {
        cur.institutional_login_url = patch
            .institutional_login_url
            .filter(|v| !v.trim().is_empty());
    }
    prune_ai_model_choice(cur);
}

// ===== 供其他模块读取的小入口（每次都从文件读，改动即时生效） =====

/// 删除 profile 时同步清掉设置里的引用（AI 专用 / 按功能绑定指到已删 id 会让
/// resolve_profile_from 的硬报错槽炸出来）。调用方须已持 profiles::store_lock
/// （profiles.delete 路径持锁内联调用，本函数不再加锁）；失败只记日志不否决删除
pub(crate) fn clear_profile_refs(id: &str) {
    let Ok(path) = settings_path() else { return };
    clear_profile_refs_at(&path, id);
}

/// 同上的路径可注入版（单测用）；失败只记日志不否决删除
fn clear_profile_refs_at(path: &Path, id: &str) {
    let mut cur = read_from(path);
    let mut touched = false;
    if cur.ai_profile_id.as_deref() == Some(id) {
        cur.ai_profile_id = None;
        cur.ai_model = None;
        touched = true;
    }
    if let Some(map) = &mut cur.ai_profiles {
        let before = map.len();
        map.retain(|_, v| v != id);
        if map.len() != before {
            touched = true;
        }
        if map.is_empty() {
            cur.ai_profiles = None;
        }
    }
    let model_before = cur.ai_model.clone();
    let models_before = cur.ai_profile_models.clone();
    prune_ai_model_choice(&mut cur);
    if cur.ai_model != model_before || cur.ai_profile_models != models_before {
        touched = true;
    }
    // 「全局生效」追踪同样清引用：已删 profile 不该继续顶着「全局生效」徽标
    if let Some(map) = &mut cur.active_global_profiles {
        let before = map.len();
        map.retain(|_, v| v != id);
        if map.len() != before {
            touched = true;
        }
        if map.is_empty() {
            cur.active_global_profiles = None;
        }
    }
    // §9 要求 settings 侧字段一次清干净：默认配置（agent→profile）与停用列表同样指向 profile id，
    // 漏清会留下永远指不到实体的幽灵 id（迁移改写路径 rewrite_profile_refs 早已覆盖这两个字段）。
    if let Some(map) = &mut cur.default_profiles {
        let before = map.len();
        map.retain(|_, v| v != id);
        if map.len() != before {
            touched = true;
        }
        if map.is_empty() {
            cur.default_profiles = None;
        }
    }
    if let Some(list) = &mut cur.hidden_profiles {
        let before = list.len();
        list.retain(|v| v != id);
        if list.len() != before {
            touched = true;
        }
        if list.is_empty() {
            cur.hidden_profiles = None;
        }
    }
    if touched {
        if let Err(e) = write_to(path, &cur) {
            crate::logbuf::record(
                "error",
                "settings",
                &format!("清理已删 profile 的设置引用失败: {e}"),
            );
        }
    }
}

/// 迁移合并时把被丢弃的 binding id 改写成保留 id。调用方须已持 store_lock。
pub(crate) fn rewrite_profile_refs(rewrites: &[(String, String)]) -> Result<(), String> {
    let path = settings_path()?;
    let mut cur = read_checked(&path)?;
    let mut touched = false;
    let subst = |v: &mut String, touched: &mut bool| {
        if let Some((_, to)) = rewrites.iter().find(|(from, _)| from == v) {
            *v = to.clone();
            *touched = true;
        }
    };
    if let Some(v) = cur.ai_profile_id.as_mut() {
        subst(v, &mut touched);
    }
    for map in [
        &mut cur.ai_profiles,
        &mut cur.default_profiles,
        &mut cur.active_global_profiles,
    ] {
        if let Some(m) = map {
            for v in m.values_mut() {
                subst(v, &mut touched);
            }
        }
    }
    if let Some(list) = &mut cur.hidden_profiles {
        for v in list.iter_mut() {
            subst(v, &mut touched);
        }
    }
    if touched {
        write_to(&path, &cur)?;
    }
    Ok(())
}

// ===== 「设为全局」追踪（active_global_profiles；见字段注释的口径说明） =====

/// 共用环境变量拒收的键，返回原因。密钥、地址、模型归连接管；代理归「出网代理」；终端与路径归 Mesa
pub fn shared_env_rejection(key: &str) -> Option<&'static str> {
    let valid = {
        let mut chars = key.chars();
        matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
            && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    };
    if !valid {
        return Some("名字只能用字母、数字和下划线，且不以数字开头");
    }
    let up = key.to_ascii_uppercase();
    if ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "AUTH", "COOKIE", "CREDENTIAL", "_PAT"]
        .iter()
        .any(|w| up.contains(w))
    {
        return Some("像密钥，密钥请填在连接里（只存在本机加密的密钥文件里）");
    }
    if up.ends_with("_BASE_URL") || up.ends_with("_MODEL") || up.contains("_MODEL_") || up.ends_with("_ENDPOINT") {
        return Some("这是连接用的地址或模型，请在连接里设");
    }
    if matches!(up.as_str(), "HTTPS_PROXY" | "HTTP_PROXY" | "ALL_PROXY" | "NO_PROXY") {
        return Some("代理请在「网络 → 出网代理」里设");
    }
    if matches!(
        up.as_str(),
        "PATH" | "HOME" | "PWD" | "SHELL" | "TERM" | "COLORTERM" | "TERM_PROGRAM" | "NO_COLOR" | "LANG" | "LC_ALL"
    ) {
        return Some("这是终端与路径相关的变量，由 Mesa 管");
    }
    None
}

/// 这个 agent 的 cc-switch 提醒是否已确认过（一键切换不再提醒）
pub(crate) fn global_conflict_acked(agent: &str) -> bool {
    read_current()
        .global_conflict_ack
        .is_some_and(|list| list.iter().any(|a| a == agent))
}

/// 记录/清除的共用内核（测试可注入路径）：Some(id) 记录或覆盖，None 清除；空 map 归一 None
fn set_active_global_at(path: &Path, agent: &str, profile_id: Option<&str>) -> Result<(), String> {
    let mut cur = read_checked(path)?;
    let mut map = cur.active_global_profiles.unwrap_or_default();
    match profile_id {
        Some(id) => {
            map.insert(agent.to_string(), id.to_string());
        }
        None => {
            map.remove(agent);
        }
    }
    cur.active_global_profiles = if map.is_empty() { None } else { Some(map) };
    write_to(path, &cur)
}

/// 「设为全局」写成功后记录（agent → profile id）；失败只记日志不影响主流程
pub(crate) fn record_active_global(agent: &str, profile_id: &str) {
    let _guard = match crate::profiles::store_lock() {
        Ok(g) => g,
        Err(e) => {
            crate::logbuf::record("error", "settings", &e);
            return;
        }
    };
    if let Ok(path) = settings_path() {
        if let Err(e) = set_active_global_at(&path, agent, Some(profile_id)) {
            crate::logbuf::record(
                "error",
                "settings",
                &format!("记录全局生效 profile 失败: {e}"),
            );
        }
    }
}

/// 恢复备份后全局内容不再是任何 profile 的快照，清除该 agent 的追踪标记
pub(crate) fn clear_active_global(agent: &str) {
    let _guard = match crate::profiles::store_lock() {
        Ok(g) => g,
        Err(e) => {
            crate::logbuf::record("error", "settings", &e);
            return;
        }
    };
    if let Ok(path) = settings_path() {
        if let Err(e) = set_active_global_at(&path, agent, None) {
            crate::logbuf::record("error", "settings", &format!("清除全局生效标记失败: {e}"));
        }
    }
}

pub(crate) fn read_current_checked() -> Result<AppSettingsDto, String> {
    read_checked(&settings_path()?)
}

pub(crate) fn read_current() -> AppSettingsDto {
    settings_path().map(|p| read_from(&p)).unwrap_or_default()
}

pub(crate) fn current_with_defaults() -> AppSettingsDto {
    with_defaults(read_current())
}

/// 浅色判定：十四套浅色主题与 custom-light 都以 `-light` 结尾，深色主题与
/// `custom` 都不是。与前端的 isLightTheme（src/themes.ts）同口径——那边靠 light
/// 标记字段、这边靠命名后缀，规则一致但实现不同，改名时两边都要动。
fn theme_is_light(theme: &str) -> bool {
    theme.ends_with("-light")
}

/// 当前持久化主题对应的原生窗口外观。
///
/// 为什么原生侧要一份：macOS 窗口材质（菜单材质 Menu）是 NSVisualEffectView，它的底色由
/// 窗口的 NSAppearance 决定，**不跟应用主题走**。系统深色 + 应用浅色时，材质本体是
/// 近黑的，浅色主题那层 78% 罩色压不住，四周 5px 缝（App.tsx 行容器 py/px）与圆角
/// 外露处就渗出黑边；深色模式两边同向，所以看不出问题。
///
/// 走 with_defaults 而不是直接读裸字段：未知/失效的 theme 会被它规范化成
/// DEFAULT_THEME，且 theme=custom 而 custom_theme 缺失时也回落默认——判定必须
/// 和用户实际看到的主题一致，不能在启动瞬间按一个被丢弃的值上外观。
pub(crate) fn current_theme_is_light() -> bool {
    let theme = current_with_defaults()
        .theme
        .unwrap_or_else(|| DEFAULT_THEME.to_string());
    theme_is_light(&theme)
}

/// 启动时窗口外观要不要交还系统：跟随系统深浅开着（首装默认关）且不是自定义配色时，
/// 前端会把主题校正成与系统同深浅的 twin（theme-follow.ts），此时强行按存的主题上外观，
/// 系统浅色的机器首帧会先闪一下深色材质
pub(crate) fn current_theme_follows_system() -> bool {
    let s = current_with_defaults();
    let custom = matches!(s.theme.as_deref(), Some("custom" | "custom-light"));
    s.theme_follow_system.unwrap_or(DEFAULT_THEME_FOLLOW_SYSTEM) && !custom
}

/// 开机套到主窗口的界面缩放（lib.rs setup，先于首帧，免得先按 100% 画一下再跳）
pub(crate) fn current_ui_zoom() -> f64 {
    current_with_defaults()
        .ui_zoom
        .unwrap_or(crate::ui_zoom::DEFAULT_ZOOM)
}

pub(crate) fn brew_mirror_enabled() -> bool {
    read_current().brew_mirror.unwrap_or(DEFAULT_BREW_MIRROR)
}

/// 会话自动命名是否启用（ai.rs 聊完起名与补名命令的闸门；设置缺失 = 默认开）
pub(crate) fn auto_title_sessions_enabled() -> bool {
    read_current()
        .auto_title_sessions
        .unwrap_or(DEFAULT_AUTO_TITLE_SESSIONS)
}

pub(crate) fn rate_setting() -> Option<f64> {
    read_current().rate_usd_cny.filter(|r| *r > 0.0)
}

/// 精确注意力标记读取口径（含旧字段迁移）：新 map 有键以它为准；
/// 旧字段 claude_hooks_attention=true 且新 map 无 claude-code 键 → 视为开
pub(crate) fn hooks_attention_enabled(s: &AppSettingsDto, agent: &str) -> bool {
    if let Some(v) = s.hooks_attention.as_ref().and_then(|m| m.get(agent)) {
        return *v;
    }
    agent == "claude-code" && s.claude_hooks_attention == Some(true)
}

/// hooks::set_hooks_attention 专用：逐键读-改-写（持 profiles 锁防并发 patch 互相覆盖，
/// 与 update_settings 同一把锁），顺带把旧字段迁移进新 map
pub(crate) fn set_hooks_attention_entry(
    agent: &str,
    enabled: bool,
) -> Result<AppSettingsDto, String> {
    let _g = crate::profiles::store_lock()?;
    set_hooks_attention_entry_at(&settings_path()?, agent, enabled)
}

fn set_hooks_attention_entry_at(
    path: &Path,
    agent: &str,
    enabled: bool,
) -> Result<AppSettingsDto, String> {
    let mut cur = read_checked(path)?;
    let mut map = cur.hooks_attention.unwrap_or_default();
    if cur.claude_hooks_attention == Some(true) && !map.contains_key("claude-code") {
        map.insert("claude-code".to_string(), true);
    }
    map.insert(agent.to_string(), enabled);
    cur.hooks_attention = Some(map);
    cur.claude_hooks_attention = None; // 已迁移，内存里也清掉（写出时本就不序列化）
    write_to(path, &cur)?;
    Ok(with_defaults(cur))
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn get_settings() -> Result<AppSettingsDto, String> {
    Ok(with_defaults(read_checked(&settings_path()?)?))
}

#[tauri::command]
pub async fn update_settings(
    app: tauri::AppHandle,
    patch: AppSettingsDto,
) -> Result<AppSettingsDto, String> {
    let zoom_changed = patch.ui_zoom.is_some();
    let out = {
        // 与 profiles 共用同一把读-改-写锁，防并发 patch 互相覆盖；
        // 本函数持锁期间不再获取其他锁，与全局写入（GLOBAL_CONFIG_MUTEX 内不调 profiles）锁序一致
        let _g = crate::profiles::store_lock()?;
        let path = settings_path()?;
        if let Some(ref proxy) = patch.outbound_proxy {
            validate_outbound_proxy(proxy)?;
        }
        if let Some(ref env) = patch.shared_env {
            for (k, v) in env {
                if let Some(why) = shared_env_rejection(k) {
                    return Err(format!("共用环境变量 {k} 不能放：{why}"));
                }
                if v.contains('\n') || v.contains('\r') {
                    return Err(format!("共用环境变量 {k} 的值不能换行"));
                }
            }
        }
        // 直发配置入 settings 前过一遍校验（merge 只搬运不校验）
        if let Some(ref smtp) = patch.feedback_smtp {
            crate::feedback::validate_smtp_config(smtp)?;
        }
        let mut cur = read_checked(&path)?;
        merge(&mut cur, patch);
        write_to(&path, &cur)?;
        with_defaults(cur)
    };
    // 放锁后再碰窗口：存下的值是准的，缩放套不上只记日志
    if zoom_changed {
        crate::ui_zoom::apply_to_main(&app, out.ui_zoom.unwrap_or(crate::ui_zoom::DEFAULT_ZOOM));
    }
    Ok(out)
}

/// 设置工作副本家目录的位置（设置页「数据与存储」）。`path` 为空 = 恢复默认 `~/ccode`。
/// 只管此后新建的工作树/副本；已有的留在原处照常用，旧位置记进曾用名单供归属判定。
/// 校验见 ccode_home::validate_base；读-改-写与 update_settings 同锁
#[tauri::command]
pub async fn set_workspace_root(path: Option<String>) -> Result<AppSettingsDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _g = crate::profiles::store_lock()?;
        let settings_file = settings_path()?;
        let new_base = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(raw) => Some(
                crate::ccode_home::validate_base(raw)?
                    .to_string_lossy()
                    .into_owned(),
            ),
            None => None,
        };
        let mut cur = read_checked(&settings_file)?;
        let history = crate::ccode_home::next_history(
            cur.workspace_root.as_deref(),
            new_base.as_deref(),
            cur.workspace_root_history.as_deref().unwrap_or_default(),
        );
        cur.workspace_root = new_base;
        cur.workspace_root_history = (!history.is_empty()).then_some(history);
        write_to(&settings_file, &cur)?;
        crate::ccode_home::invalidate();
        Ok(with_defaults(cur))
    })
    .await
    .map_err(|e| format!("设置工作副本位置失败: {e}"))?
}

/// 清除反馈邮箱直发配置（settings 侧；授权码另有 clear_feedback_smtp_secret）。
/// 不走 update_settings：Option<T> 下前端传 null 反序列化为 None、与字段缺失
/// 无异，merge 不会触发——清空语义必须专用命令（clear_profile_refs_at 先例）。
#[tauri::command]
pub async fn clear_feedback_smtp_config() -> Result<AppSettingsDto, String> {
    let _g = crate::profiles::store_lock()?;
    let path = settings_path()?;
    let mut cur = read_checked(&path)?;
    cur.feedback_smtp = None;
    write_to(&path, &cur)?;
    Ok(with_defaults(cur))
}

/// 出网代理自动检测（设置页「检测」按钮）：只出候选供点选，不改写任何设置
#[tauri::command]
pub async fn detect_outbound_proxy() -> Result<Vec<OutboundProxyCandidateDto>, String> {
    tauri::async_runtime::spawn_blocking(detect_outbound_proxy_inner)
        .await
        .map_err(|e| format!("代理检测失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn corrupt_settings_are_not_overwritten_by_patch() {
        let p = tmp();
        std::fs::write(&p, "{invalid}").unwrap();
        assert!(read_checked(&p).is_err());
        assert!(write_to(&p, &AppSettingsDto::default()).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{invalid}");
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }

    #[test]
    fn clear_profile_refs_clears_all_five_fields() {
        let p = tmp();
        let mut s = AppSettingsDto::default();
        s.ai_profile_id = Some("gone".into());
        s.ai_model = Some("glm-5.3-flashx".into());
        s.ai_profiles = Some(BTreeMap::from([
            ("commit".to_string(), "gone".to_string()),
            ("summarize".to_string(), "keep".to_string()),
        ]));
        s.ai_profile_models = Some(BTreeMap::from([
            ("commit".to_string(), "flash".to_string()),
            ("summarize".to_string(), "keep-model".to_string()),
        ]));
        s.default_profiles = Some(BTreeMap::from([
            ("claude-code".to_string(), "gone".to_string()),
            ("gemini".to_string(), "keep".to_string()),
        ]));
        s.hidden_profiles = Some(vec!["gone".into(), "keep".into()]);
        s.active_global_profiles = Some(BTreeMap::from([(
            "claude-code".to_string(),
            "gone".to_string(),
        )]));
        write_to(&p, &s).unwrap();
        clear_profile_refs_at(&p, "gone");
        let after = read_checked(&p).unwrap();
        assert_eq!(after.ai_profile_id, None);
        assert_eq!(after.ai_model, None, "删掉专用配置时选中的模型一起清");
        assert_eq!(
            after.ai_profiles,
            Some(BTreeMap::from([(
                "summarize".to_string(),
                "keep".to_string()
            )]))
        );
        assert_eq!(
            after.ai_profile_models,
            Some(BTreeMap::from([(
                "summarize".to_string(),
                "keep-model".to_string()
            )]))
        );
        assert_eq!(
            after.default_profiles,
            Some(BTreeMap::from([("gemini".to_string(), "keep".to_string())])),
            "默认配置里的幽灵引用必须一起清（§9 settings 五字段）"
        );
        assert_eq!(after.hidden_profiles, Some(vec!["keep".to_string()]));
        assert_eq!(after.active_global_profiles, None);
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }

    #[test]
    fn scutil_proxy_parsing_takes_enabled_entries() {
        let text = "<dictionary> {\n  HTTPEnable : 0\n  HTTPProxy : 0.0.0.0\n  HTTPPort : 0\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7890\n  SOCKSEnable : 1\n  SOCKSProxy : 127.0.0.1\n  SOCKSPort : 1080\n}\n";
        assert_eq!(
            parse_scutil_proxy(text),
            vec![
                "https://127.0.0.1:7890".to_string(),
                "socks5://127.0.0.1:1080".to_string(),
            ]
        );
        // 全关：无产出
        assert!(parse_scutil_proxy("HTTPEnable : 0").is_empty());
    }

    #[test]
    fn windows_reg_proxy_parsing_covers_both_forms() {
        let plain = "HKEY_CURRENT_...\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
        assert_eq!(
            parse_windows_reg_proxy(plain),
            vec!["http://127.0.0.1:7890".to_string()]
        );
        let per_proto = "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080\n";
        assert_eq!(
            parse_windows_reg_proxy(per_proto),
            vec!["https://127.0.0.1:7891".to_string()]
        );
        // 未启用：无产出
        let off =
            "    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
        assert!(parse_windows_reg_proxy(off).is_empty());
    }

    #[test]
    fn proxy_env_value_normalizes_scheme() {
        assert_eq!(
            normalize_proxy_env_value("127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_env_value("socks5://127.0.0.1:1080"),
            "socks5://127.0.0.1:1080"
        );
        assert_eq!(normalize_proxy_env_value("  http://p:80  "), "http://p:80");
        assert_eq!(normalize_proxy_env_value(""), "");
    }

    #[test]
    fn missing_file_merges_to_full_defaults() {
        let p = tmp();
        let full = with_defaults(read_from(&p));
        assert_eq!(full.terminal_font_size, Some(14));
        assert_eq!(full.scrollback, Some(5000));
        assert_eq!(full.rate_usd_cny, Some(7.2));
        assert_eq!(full.brew_mirror, Some(true));
        assert_eq!(full.auto_title_sessions, Some(true));
        assert_eq!(full.theme.as_deref(), Some("neutral"));
        assert_eq!(full.theme_follow_system, Some(false));
        // 存过「跟随」的老设置照旧
        let kept = with_defaults(AppSettingsDto {
            theme: Some("ayu".into()),
            theme_follow_system: Some(true),
            ..Default::default()
        });
        assert_eq!(kept.theme.as_deref(), Some("ayu"));
        assert_eq!(kept.theme_follow_system, Some(true));
        // 100 = 各主题原有罩色，是「没调过和以前一模一样」的那一档
        assert_eq!(full.chrome_opacity, Some(100));
        assert_eq!(full.startup_nav_mode, None);
        assert_eq!(full.nav_capsule_hide_delay_ms, Some(1000));
        assert_eq!(full.nav_capsule_display_mode, None);
        assert_eq!(full.nav_capsule_visible_items, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn active_global_record_overwrite_and_clear() {
        let p = tmp();
        set_active_global_at(&p, "codex", Some("prof-1")).unwrap();
        set_active_global_at(&p, "kimi", Some("prof-2")).unwrap();
        let cur = read_from(&p);
        assert_eq!(
            cur.active_global_profiles
                .as_ref()
                .unwrap()
                .get("codex")
                .map(String::as_str),
            Some("prof-1")
        );
        // 同 agent 再记录 = 覆盖（切换「设为全局」的对象）
        set_active_global_at(&p, "codex", Some("prof-3")).unwrap();
        // 清除某个 agent 不影响其他 agent 的标记
        set_active_global_at(&p, "codex", None).unwrap();
        let cur = read_from(&p);
        let map = cur.active_global_profiles.as_ref().unwrap();
        assert!(!map.contains_key("codex"));
        assert_eq!(map.get("kimi").map(String::as_str), Some("prof-2"));
        // 全清后归一 None，不留空对象污染 settings.json
        set_active_global_at(&p, "kimi", None).unwrap();
        assert_eq!(read_from(&p).active_global_profiles, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn navigation_settings_validate_and_roundtrip() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                startup_nav_mode: Some("hidden".into()),
                nav_capsule_hide_delay_ms: Some(2000),
                nav_capsule_display_mode: Some("icons".into()),
                nav_capsule_visible_items: Some(vec!["workbench".into(), "settings".into()]),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let full = with_defaults(read_from(&p));
        assert_eq!(full.startup_nav_mode.as_deref(), Some("hidden"));
        assert_eq!(full.nav_capsule_hide_delay_ms, Some(2000));
        assert_eq!(full.nav_capsule_display_mode.as_deref(), Some("icons"));
        assert_eq!(
            full.nav_capsule_visible_items,
            Some(vec!["workbench".into(), "settings".into()])
        );

        let mut invalid = read_from(&p);
        merge(
            &mut invalid,
            AppSettingsDto {
                startup_nav_mode: Some("nope".into()),
                nav_capsule_hide_delay_ms: Some(999),
                chrome_opacity: Some(999),
                app_icon_style: Some("neon".into()),
                chat_font_size: Some("huge".into()),
                chat_font_family: Some("comic".into()),
                chat_accent: Some("neon".into()),
                chat_scrollbar: Some("never".into()),
                nav_capsule_display_mode: Some("text".into()),
                nav_capsule_visible_items: Some(vec!["workbench".into(), "unknown".into()]),
                ..Default::default()
            },
        );
        let invalid_full = with_defaults(invalid);
        assert_eq!(invalid_full.startup_nav_mode, None);
        assert_eq!(invalid_full.nav_capsule_hide_delay_ms, Some(1000));
        assert_eq!(invalid_full.nav_capsule_display_mode, None);
        assert_eq!(invalid_full.chrome_opacity, Some(100));
        assert_eq!(invalid_full.app_icon_style.as_deref(), Some("system"));
        assert_eq!(invalid_full.chat_accent.as_deref(), Some("warm"));
        assert_eq!(invalid_full.chat_font_size.as_deref(), Some("normal"));
        assert_eq!(invalid_full.chat_font_family.as_deref(), Some("system"));
        assert_eq!(invalid_full.chat_scrollbar.as_deref(), Some("auto"));
        assert_eq!(
            invalid_full.nav_capsule_visible_items,
            Some(vec!["workbench".into()])
        );

        // 0 = 立即，是合法档位而非「未设置」：前端加这一档时 Rust 白名单没跟上，
        // 0 被判非法后静默落回 1000，用户看到的就是「选了立即还是 1 秒」。
        // 这条断言把两侧白名单钉在一起，任何一边漏加都会在这里红。
        let mut zero = read_from(&p);
        merge(
            &mut zero,
            AppSettingsDto {
                nav_capsule_hide_delay_ms: Some(0),
                ..Default::default()
            },
        );
        write_to(&p, &zero).unwrap();
        assert_eq!(
            with_defaults(read_from(&p)).nav_capsule_hide_delay_ms,
            Some(0)
        );
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn status_bar_unified_toggle_migrates_legacy_chat_only() {
        let p = tmp();
        // 老用户：聊天页关过状态栏 → 迁移为统一关闭
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                status_bar_in_chat: Some(false),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        assert_eq!(with_defaults(read_from(&p)).status_bar, Some(false));
        // 新开关一旦显式写入即胜出（不再受旧字段影响）
        let mut cur2 = read_from(&p);
        merge(
            &mut cur2,
            AppSettingsDto {
                status_bar: Some(true),
                ..Default::default()
            },
        );
        write_to(&p, &cur2).unwrap();
        assert_eq!(with_defaults(read_from(&p)).status_bar, Some(true));
        // 未写过任何字段 → 默认开
        std::fs::remove_file(&p).unwrap();
        assert_eq!(with_defaults(read_from(&p)).status_bar, Some(true));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn workspace_root_survives_patches_and_is_not_patchable() {
        let p = tmp();
        let mut cur = read_from(&p);
        cur.workspace_root = Some("D:/mesa".into());
        cur.workspace_root_history = Some(vec!["E:/old".into()]);
        write_to(&p, &cur).unwrap();
        // 别的字段的 patch 不得动它；patch 里带这两个字段也不生效（只能经 set_workspace_root）
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                scrollback: Some(5000),
                workspace_root: Some("X:/hijack".into()),
                workspace_root_history: Some(vec![]),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let back = with_defaults(read_from(&p));
        assert_eq!(back.workspace_root.as_deref(), Some("D:/mesa"));
        assert_eq!(back.workspace_root_history, Some(vec!["E:/old".to_string()]));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn auto_title_sessions_toggle_roundtrip() {
        let p = tmp();
        // 缺省 = 默认开（老用户没写过这个字段，行为不变）
        assert_eq!(
            with_defaults(read_from(&p)).auto_title_sessions,
            Some(true)
        );
        // 关：patch 落盘后读回应为 Some(false)，不被默认值吞掉
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                auto_title_sessions: Some(false),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        assert_eq!(
            with_defaults(read_from(&p)).auto_title_sessions,
            Some(false)
        );
        // 再打开
        let mut cur2 = read_from(&p);
        merge(
            &mut cur2,
            AppSettingsDto {
                auto_title_sessions: Some(true),
                ..Default::default()
            },
        );
        write_to(&p, &cur2).unwrap();
        assert_eq!(
            with_defaults(read_from(&p)).auto_title_sessions,
            Some(true)
        );
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn image_gen_pair_saves_together_and_clears_together() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                image_gen_gateway_id: Some("gw-1".into()),
                image_gen_model: Some(" gpt-image-2.5 ".into()),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let back = with_defaults(read_from(&p));
        assert_eq!(back.image_gen_gateway_id.as_deref(), Some("gw-1"));
        assert_eq!(back.image_gen_model.as_deref(), Some("gpt-image-2.5"));
        // 无关 patch 不动它
        merge(&mut cur, AppSettingsDto { auto_title_sessions: Some(false), ..Default::default() });
        assert_eq!(cur.image_gen_model.as_deref(), Some("gpt-image-2.5"));
        // 只给一半（模型空串）= 两个一起清空，不留半套配置
        merge(
            &mut cur,
            AppSettingsDto {
                image_gen_gateway_id: Some("gw-1".into()),
                image_gen_model: Some(String::new()),
                ..Default::default()
            },
        );
        assert_eq!((cur.image_gen_gateway_id.clone(), cur.image_gen_model.clone()), (None, None));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn terminal_renderer_closed_set_roundtrip() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                terminal_renderer: Some("webgl".into()),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        assert_eq!(
            with_defaults(read_from(&p)).terminal_renderer.as_deref(),
            Some("webgl")
        );
        // 闭集外的值读时静默丢弃（前端回落 auto）
        let mut invalid = read_from(&p);
        merge(
            &mut invalid,
            AppSettingsDto {
                terminal_renderer: Some("gpu".into()),
                ..Default::default()
            },
        );
        write_to(&p, &invalid).unwrap();
        assert_eq!(with_defaults(read_from(&p)).terminal_renderer, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn partial_update_keeps_other_fields() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                terminal_font_size: Some(15),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        // 第二次 patch 只动 theme，font_size 应保留
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                theme: Some("dracula".into()),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let full = with_defaults(read_from(&p));
        assert_eq!(
            full.terminal_font_size,
            Some(15),
            "前次写入的字段不被后续 patch 覆盖"
        );
        assert_eq!(full.theme.as_deref(), Some("dracula"));
        assert_eq!(full.brew_mirror, Some(true));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn unknown_theme_falls_back_to_default() {
        let full = with_defaults(AppSettingsDto {
            theme: Some("neon".into()),
            ..Default::default()
        });
        assert_eq!(full.theme.as_deref(), Some(DEFAULT_THEME));
    }

    #[test]
    fn custom_theme_roundtrip_and_invalid_hex_dropped() {
        let ok = with_defaults(AppSettingsDto {
            theme: Some("custom".into()),
            custom_theme: Some(CustomThemeDto {
                rail: Some("#abc".into()),
                canvas: Some("101218".into()),
                accent: Some("#FAA8D4".into()),
            }),
            ..Default::default()
        });
        assert_eq!(ok.theme.as_deref(), Some("custom"));
        assert_eq!(
            ok.custom_theme,
            Some(CustomThemeDto {
                rail: Some("#aabbcc".into()),
                canvas: Some("#101218".into()),
                accent: Some("#faa8d4".into()),
            })
        );
        let bad = with_defaults(AppSettingsDto {
            theme: Some("custom-light".into()),
            custom_theme: Some(CustomThemeDto {
                rail: Some("#111111".into()),
                canvas: Some("not-a-color".into()),
                accent: Some("#ff0000".into()),
            }),
            ..Default::default()
        });
        assert_eq!(bad.theme.as_deref(), Some(DEFAULT_THEME));
        assert_eq!(bad.custom_theme, None);
    }

    #[test]
    fn custom_theme_cards_sanitize_and_card_id() {
        let full = with_defaults(AppSettingsDto {
            custom_themes: Some(vec![
                CustomThemeCardDto {
                    id: Some("c1".into()),
                    name: Some("  实验  室 ".into()),
                    rail: Some("#111".into()),
                    canvas: Some("#222222".into()),
                    accent: Some("#f00".into()),
                },
                CustomThemeCardDto {
                    id: Some("bad id".into()),
                    name: Some("x".into()),
                    rail: Some("#111111".into()),
                    canvas: Some("#222222".into()),
                    accent: Some("#ff0000".into()),
                },
            ]),
            custom_theme_card_id: Some("c1".into()),
            ..Default::default()
        });
        let cards = full.custom_themes.as_ref().expect("cards");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].id.as_deref(), Some("c1"));
        assert_eq!(cards[0].name.as_deref(), Some("实验 室"));
        assert_eq!(full.custom_theme_card_id.as_deref(), Some("c1"));
        let miss = with_defaults(AppSettingsDto {
            custom_themes: full.custom_themes.clone(),
            custom_theme_card_id: Some("gone".into()),
            ..Default::default()
        });
        assert_eq!(miss.custom_theme_card_id, None);
    }

    #[test]
    fn open_surface_defaults_to_chat_and_rejects_unknown() {
        assert_eq!(with_defaults(AppSettingsDto::default()).open_surface.as_deref(), Some("chat"));
        for (raw, want) in [("terminal", "terminal"), ("chat", "chat"), ("split", "chat")] {
            let full = with_defaults(AppSettingsDto {
                open_surface: Some(raw.into()),
                ..Default::default()
            });
            assert_eq!(full.open_surface.as_deref(), Some(want), "{raw}");
        }
    }

    #[test]
    fn external_terminal_defaults_to_auto_and_rejects_unknown() {
        // 缺失 → auto
        let full = with_defaults(AppSettingsDto::default());
        assert_eq!(full.external_terminal.as_deref(), Some("auto"));
        // 未知值 → auto；已知值保留
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("warp".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("auto"));
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("ghostty".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("ghostty"));
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("cmd".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("cmd"));
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("powershell".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("powershell"));
    }

    #[test]
    fn ai_profile_id_empty_string_clears_to_auto() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("p-1".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profile_id.as_deref(), Some("p-1"));
        // 传空字符串 = 清空回「自动」
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profile_id, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn ai_profiles_merge_overwrites_whole_map() {
        let p = tmp();
        let mut cur = read_from(&p);
        // 首次写入两个功能键
        let mut m = BTreeMap::new();
        m.insert("commit".to_string(), "p-1".to_string());
        m.insert("summarize".to_string(), "p-2".to_string());
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profiles: Some(m),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profiles.as_ref().unwrap().len(), 2);
        // Some 即整图覆盖：改一键后整体提交，旧键按新 map 去留
        let mut m2 = BTreeMap::new();
        m2.insert("commit".to_string(), "p-3".to_string());
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profiles: Some(m2),
                ..Default::default()
            },
        );
        let map = cur.ai_profiles.as_ref().unwrap();
        assert_eq!(map.get("commit").map(String::as_str), Some("p-3"));
        assert!(!map.contains_key("summarize"), "整图覆盖，未提交的键被删除");
        // patch 缺省（None）不动现有 map
        merge(&mut cur, AppSettingsDto::default());
        assert_eq!(cur.ai_profiles.as_ref().unwrap().len(), 1);
        // with_defaults 原样透传，不填默认
        let full = with_defaults(cur);
        assert_eq!(full.ai_profiles.as_ref().unwrap().len(), 1);
        assert_eq!(with_defaults(AppSettingsDto::default()).ai_profiles, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn ai_model_follows_the_profile_it_belongs_to() {
        let mut cur = AppSettingsDto::default();
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("p-1".into()),
                ai_model: Some("glm-5.3-flashx".into()),
                ai_profiles: Some(BTreeMap::from([("commit".into(), "p-2".into())])),
                ai_profile_models: Some(BTreeMap::from([
                    ("commit".into(), "deepseek-v4.1-flash".into()),
                    ("summarize".into(), "orphan".into()),
                ])),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_model.as_deref(), Some("glm-5.3-flashx"));
        assert_eq!(
            cur.ai_profile_models
                .as_ref()
                .unwrap()
                .get("commit")
                .map(String::as_str),
            Some("deepseek-v4.1-flash")
        );
        assert!(
            !cur.ai_profile_models
                .as_ref()
                .unwrap()
                .contains_key("summarize"),
            "没有对应功能配置的模型不保留"
        );
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profile_id, None);
        assert_eq!(cur.ai_model, None, "回到自动时不留上一次的模型");
    }

    #[test]
    fn hooks_attention_roundtrip_and_legacy_migration() {
        let p = tmp();
        // 缺省 → 空 map
        assert_eq!(
            with_defaults(read_from(&p)).hooks_attention,
            Some(BTreeMap::new())
        );
        // 整图 patch 写读往返
        let mut cur = read_from(&p);
        let mut m = BTreeMap::new();
        m.insert("claude-code".to_string(), true);
        m.insert("kimi".to_string(), false);
        merge(
            &mut cur,
            AppSettingsDto {
                hooks_attention: Some(m),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let full = with_defaults(read_from(&p));
        let map = full.hooks_attention.unwrap();
        assert_eq!(map.get("claude-code"), Some(&true), "写读往返");
        assert_eq!(map.get("kimi"), Some(&false));
        // 写出不含旧字段
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("claudeHooksAttention"), "旧字段不再写出");
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn legacy_claude_hooks_attention_migrates_into_map() {
        let p = tmp();
        // 磁盘上只有旧字段 true → with_defaults 迁移为 map 里 claude-code=true
        std::fs::write(&p, r#"{"claudeHooksAttention": true}"#).unwrap();
        let full = with_defaults(read_from(&p));
        assert_eq!(
            full.hooks_attention.as_ref().unwrap().get("claude-code"),
            Some(&true),
            "旧字段 true 迁移进新 map"
        );
        // 读取口径：未迁移的原始 DTO 也认旧字段
        assert!(hooks_attention_enabled(&read_from(&p), "claude-code"));
        assert!(!hooks_attention_enabled(&read_from(&p), "kimi"));
        // 新 map 已有 claude-code 键时以新 map 为准（旧 true 不覆盖显式 false）
        std::fs::write(
            &p,
            r#"{"claudeHooksAttention": true, "hooksAttention": {"claude-code": false}}"#,
        )
        .unwrap();
        assert!(!hooks_attention_enabled(&read_from(&p), "claude-code"));
        // 专用写入：逐键读写 + 顺带迁移旧字段，写出后旧字段消失
        let full = set_hooks_attention_entry_at(&p, "qwen", true).unwrap();
        assert_eq!(
            full.hooks_attention.as_ref().unwrap().get("qwen"),
            Some(&true)
        );
        let disk = std::fs::read_to_string(&p).unwrap();
        assert!(
            !disk.contains("claudeHooksAttention"),
            "旧字段随迁移从磁盘消失"
        );
        let v: serde_json::Value = serde_json::from_str(&disk).unwrap();
        assert_eq!(
            v["hooksAttention"]["claude-code"], false,
            "迁移以新 map 为准"
        );
        assert_eq!(v["hooksAttention"]["qwen"], true);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// 「想法期只读保护」开关 2026-10-26 收掉（聊想法固定只读开聊）：旧 settings.json 里留着的键读进来不报错、写回时丢掉
    #[test]
    fn retired_discuss_readonly_key_is_ignored() {
        let p = tmp();
        std::fs::write(&p, r#"{"discussReadonly":false,"theme":"dark"}"#).unwrap();
        let cur = read_from(&p);
        write_to(&p, &cur).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("discussReadonly"), "{text}");
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn feedback_smtp_merges_when_present_and_keeps_old_when_absent() {
        let cfg = crate::feedback::FeedbackSmtpConfigDto {
            provider: "QQ 邮箱".into(),
            host: "smtp.qq.com".into(),
            port: 465,
            tls: "tls".into(),
            from: "a@b.c".into(),
        };
        // 缺字段（null 反序列化同形）：不清不动
        let mut cur = AppSettingsDto::default();
        merge(&mut cur, AppSettingsDto::default());
        assert!(cur.feedback_smtp.is_none());
        // Some 覆盖；再 merge 缺字段的 patch 保持已配置
        merge(
            &mut cur,
            AppSettingsDto {
                feedback_smtp: Some(cfg.clone()),
                ..Default::default()
            },
        );
        assert_eq!(cur.feedback_smtp.as_ref(), Some(&cfg));
        merge(&mut cur, AppSettingsDto::default());
        assert_eq!(cur.feedback_smtp.as_ref(), Some(&cfg));
    }

    #[test]
    fn outbound_proxy_env_and_validation() {
        assert!(validate_outbound_proxy("").is_ok());
        assert!(validate_outbound_proxy("  http://127.0.0.1:7890  ").is_ok());
        assert!(validate_outbound_proxy("socks5://127.0.0.1:7891").is_ok());
        assert!(validate_outbound_proxy("https://proxy.example.com:443").is_ok());
        assert!(validate_outbound_proxy("ftp://127.0.0.1:21").is_err());
        assert!(validate_outbound_proxy("127.0.0.1:7890").is_err());
        assert!(validate_outbound_proxy("http://").is_err());

        let empty = official_outbound_env_from(&AppSettingsDto::default());
        assert!(empty.is_empty());

        let env = official_outbound_env_from(&AppSettingsDto {
            outbound_proxy: Some("http://127.0.0.1:7890".into()),
            outbound_no_proxy: None,
            ..Default::default()
        });
        assert_eq!(
            env,
            vec![
                ("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into()),
                ("HTTP_PROXY".into(), "http://127.0.0.1:7890".into()),
                ("ALL_PROXY".into(), "http://127.0.0.1:7890".into()),
                ("NO_PROXY".into(), DEFAULT_NO_PROXY.into()),
            ]
        );

        let custom = official_outbound_env_from(&AppSettingsDto {
            outbound_proxy: Some("http://127.0.0.1:7890".into()),
            outbound_no_proxy: Some("localhost,example.com".into()),
            ..Default::default()
        });
        assert!(custom
            .iter()
            .any(|(k, v)| k == "NO_PROXY" && v == "localhost,example.com"));

        let bad = official_outbound_env_from(&AppSettingsDto {
            outbound_proxy: Some("not-a-url".into()),
            ..Default::default()
        });
        assert!(bad.is_empty(), "磁盘脏值不注入");

        // 下载侧：大小写成对 + 镜像主机并入 NO_PROXY
        assert!(download_proxy_env_from(&AppSettingsDto::default(), &[]).is_empty());
        let dl = download_proxy_env_from(
            &AppSettingsDto {
                outbound_proxy: Some("socks5://127.0.0.1:10808".into()),
                ..Default::default()
            },
            &["ghcr.nju.edu.cn", "mirrors.tuna.tsinghua.edu.cn"],
        );
        for k in [
            "http_proxy",
            "HTTP_PROXY",
            "https_proxy",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
            "no_proxy",
            "NO_PROXY",
        ] {
            assert!(dl.iter().any(|(ek, _)| ek == k), "缺 {k}");
        }
        let np = dl
            .iter()
            .find(|(k, _)| k == "no_proxy")
            .map(|(_, v)| v.clone())
            .unwrap();
        for host in [
            "127.0.0.1",
            "ghcr.nju.edu.cn",
            "mirrors.tuna.tsinghua.edu.cn",
        ] {
            assert!(
                np.split(',').any(|e| e.trim() == host),
                "NO_PROXY 缺 {host}"
            );
        }
        // 用户自定义 no_proxy 优先，镜像主机去重追加
        let custom = download_proxy_env_from(
            &AppSettingsDto {
                outbound_proxy: Some("http://127.0.0.1:7890".into()),
                outbound_no_proxy: Some("localhost,ghcr.nju.edu.cn".into()),
                ..Default::default()
            },
            &["ghcr.nju.edu.cn", "mirrors.tuna.tsinghua.edu.cn"],
        );
        let np2 = custom
            .iter()
            .find(|(k, _)| k == "NO_PROXY")
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(
            np2,
            "localhost,ghcr.nju.edu.cn,mirrors.tuna.tsinghua.edu.cn"
        );
        assert!(
            download_proxy_env_from(
                &AppSettingsDto {
                    outbound_proxy: Some("not-a-url".into()),
                    ..Default::default()
                },
                &[],
            )
            .is_empty(),
            "脏值不注入"
        );

        let mut cur = AppSettingsDto::default();
        merge(
            &mut cur,
            AppSettingsDto {
                outbound_proxy: Some("http://127.0.0.1:7890".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.outbound_proxy.as_deref(), Some("http://127.0.0.1:7890"));
        merge(
            &mut cur,
            AppSettingsDto {
                outbound_proxy: Some("  ".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.outbound_proxy, None, "空串清掉出网代理");
    }
}

/// 应用数据占用（设置页「数据与存储」）：用户此前完全不知道 Mesa 在硬盘上占了多少、存在哪。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntryDto {
    /// 展示名（app.db / 技能库 / 会话快照 …）
    pub label: String,
    /// 绝对路径（前端只展示与「打开目录」，不参与任何写操作）
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
    /// 可清理（快照与备份是可再生/可丢的；profiles/keys/app.db 一律 false）
    pub clearable: bool,
    /// 清理用的条目键（= 配置目录下的相对名；工作副本两项为 `~worktrees` / `~workspaces`，不可清理）
    pub id: String,
    /// 目录太大、统计达到条目上限提前收手：bytes 是下限，前端显示「≥」
    pub approx: bool,
    /// 归属：config = Mesa 配置目录；home = 当前家目录（默认 ~/ccode）下的工作副本；
    /// home-old = 换位置前遗留在旧家目录里的工作副本
    pub root: String,
}

/// 可清理条目白名单（clear_storage_entry 只认这里的相对名，防前端传任意路径）。
/// 2026-10-17 落地清理时逐项核过，只有快照能清：
/// - backups 里有「恢复初始状态」要用的首次写入前原样（永久保留）与「撤销上次写入」批次
/// - catalogs 被 Codex「设为全局默认」写进了 ~/.codex/config.toml，删了 Mesa 外直跑的 codex 读不到模型目录
const CLEARABLE_STORAGE: [&str; 1] = ["snapshots"];

/// 递归求目录大小；单个条目读失败按 0 计（宁可少算也不报错——这只是个信息展示）。
/// 有界：最多下钻 2000 个条目，异常巨大的目录返回已累计值，不卡住设置页。
fn dir_size(path: &std::path::Path, budget: &mut u32) -> u64 {
    if *budget == 0 {
        return 0;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        *budget = budget.saturating_sub(1);
        return meta.len();
    }
    // 符号链接不跟随（技能分发可能是 symlink，跟随会重复计入甚至成环）
    if meta.is_symlink() || !meta.is_dir() {
        return 0;
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for e in rd.flatten() {
        if *budget == 0 {
            break;
        }
        total = total.saturating_add(dir_size(&e.path(), budget));
    }
    total
}

#[tauri::command]
pub async fn app_storage_usage() -> Result<Vec<StorageEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode");
        // (展示名, 相对名, 可清理)
        let items: [(&str, &str, bool); 7] = [
            ("会话索引与用量（app.db）", "app.db", false),
            ("配置（profiles.json）", "profiles.json", false),
            ("技能库", "skills", false),
            ("会话快照（pin 保留的）", "snapshots", true),
            ("配置改写备份", "backups", false),
            ("Codex 模型目录", "catalogs", false),
            ("定时冻结证据与恢复备份", "watch-reviews", false),
        ];
        let mut out = Vec::new();
        for (label, rel, clearable) in items {
            out.push(storage_entry(label, root.join(rel), rel, clearable, "config"));
        }
        // 工作副本（2026-10-17 补列）：往往才是大头，此前用户完全看不到。
        // 不可在这里清——里面是正在用的工作树，删了会把进行中的目标弄坏，走项目页的归档/删除。
        // 家目录可被用户换位置（2026-10-18）：当前根列 home，换走后仍留着旧树的位置列 home-old，
        // 让人看得见 C 盘上还剩什么
        let homes = crate::ccode_home::all_roots();
        for (idx, home_root) in homes.iter().enumerate() {
            let (root, tag) = if idx == 0 { ("home", "") } else { ("home-old", "old-") };
            if idx > 0 && !home_root.exists() {
                continue;
            }
            for (label, dir) in [
                ("编程工作树", "worktrees"),
                ("科研工作副本", "workspaces"),
                ("定时隔离树", "watch-worktrees"),
            ] {
                let path = home_root.join(dir);
                if idx > 0 && !path.exists() {
                    continue;
                }
                out.push(storage_entry(
                    label,
                    path,
                    &format!("~{tag}{dir}"),
                    false,
                    root,
                ));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("统计应用数据占用失败: {e}"))?
}

fn storage_entry(
    label: &str,
    path: std::path::PathBuf,
    id: &str,
    clearable: bool,
    root: &str,
) -> StorageEntryDto {
    let exists = path.exists();
    let mut budget = 20_000u32;
    let bytes = if exists { dir_size(&path, &mut budget) } else { 0 };
    StorageEntryDto {
        label: label.to_string(),
        path: path.to_string_lossy().to_string(),
        bytes,
        exists,
        clearable,
        id: id.to_string(),
        approx: exists && budget == 0,
        root: root.to_string(),
    }
}

/// 清理一项可清理的应用数据（设置页「数据与存储」）：整目录移进系统回收站（可拖回），
/// 再建回空目录——各写手按需 create_dir_all，空目录只是让「定位」仍有地方可去。
/// 只认 CLEARABLE_STORAGE 白名单里的相对名，前端传不了任意路径
#[tauri::command]
pub async fn clear_storage_entry(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !CLEARABLE_STORAGE.contains(&id.as_str()) {
            return Err(format!("这一项不能在这里清理：{id}"));
        }
        let path = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode")
            .join(&id);
        if !path.exists() {
            return Ok(());
        }
        crate::projects::trash_delete_retry(&path, "应用数据目录")?;
        std::fs::create_dir_all(&path).map_err(|e| format!("清理后重建空目录失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("清理应用数据失败: {e}"))?
}
