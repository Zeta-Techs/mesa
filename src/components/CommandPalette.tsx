import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  BookOpen,
  BookText,
  Check,
  Compass,
  Download,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  FolderClosed,
  Info,
  Megaphone,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Smartphone,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { usePhoneDropStore } from "../phone-drop-store";
import { openOnboardingGuide } from "./OnboardingGuide";
import { filterCommands, matchedKeyword, type PaletteCommand } from "../command-palette";
import { DEFAULT_THEME_ID, THEMES } from "../themes";
import { followedTheme } from "../theme-follow";
import {
  customThemeIdFromSeeds,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  isCustomThemeId,
  normalizeCustomTheme,
  normalizeCustomThemeCards,
  resolveCustomThemeCardId,
  type CustomThemeSeeds,
} from "../custom-theme";
import {
  parseThemeSwatchesFromCss,
  themeSwatchFor,
  type ThemeSwatch,
} from "../theme-swatch";
import { comboLabel, PAGE_HOTKEY_DEFS } from "../hotkeys";
import { NAV_ICONS } from "../navigation-icons";
import { SETTINGS_SEARCH_INDEX } from "../settings-search";
import { WORK_MODE_LABEL, normalizeWorkMode } from "../work-mode";
import { REPO_URL, userGuideUrl } from "../help-links";
import { imeBlocksEnter } from "../ime-guard";
import type { ProjectDto } from "../types";
import { useAnimatedDismiss } from "../exit-animation";
import { toast } from "../toast";

/** 面板里能打开的帮助类弹窗（宿主在 App：反馈表单与 HelpDialogs） */
export type PaletteHelpTarget = "feedback" | "diag" | "update" | "about";

type Entry = {
  cmd: PaletteCommand;
  run: () => void;
  icon?: ReactNode;
  /** 主题行的色样（左栏 / 画布 / 强调） */
  swatch?: Pick<ThemeSwatch, "rail" | "canvas" | "accent"> | null;
  /** 行尾 ↗：在浏览器打开 */
  external?: boolean;
  /** 当前生效项（主题）：行尾打勾 */
  current?: boolean;
  /** 快捷键提示用等宽字 */
  kbd?: boolean;
  /** 执行后不关面板（进主题子列表） */
  keepOpen?: boolean;
};

/** 主题网格的一格（也生成根列表里「主题：…」的搜索条目） */
type ThemeOption = {
  key: string;
  /** 格子上的名字：浅色去掉「 · 浅」，所在组已经说明了深浅 */
  family: string;
  fullName: string;
  group: "深色" | "浅色" | "自定义";
  light: boolean;
  colors: Pick<ThemeSwatch, "rail" | "canvas" | "accent" | "ink"> | null;
  keywords: string[];
  current: boolean;
  apply: () => void;
};

/** 主题网格每行格数（与设置页主题卡同为 7 列，深浅两行上下对齐） */
const THEME_COLS = 7;

/** 主题格：与设置页主题卡同一副长相——画布底、左栏条、右上强调色点、左下名字用该主题字色；
 *  当前主题在强调点旁打勾，键盘 / 鼠标所在格描一圈 */
function PaletteThemeTile({
  option,
  idx,
  active,
  onPick,
  onHover,
}: {
  option: ThemeOption;
  idx: number;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const c = option.colors;
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onPick}
      onMouseMove={onHover}
      title={option.current ? `${option.fullName}（当前）` : option.fullName}
      aria-pressed={option.current}
      className={`h-14 w-full min-w-0 overflow-hidden rounded-md text-left transition-shadow ${
        active ? "ring-2 ring-l1" : "ring-1 ring-hairline"
      }`}
      style={{ background: c?.canvas ?? "var(--color-inset)" }}
    >
      <span className="flex h-full">
        <span className="w-2.5 shrink-0" style={{ background: c?.rail }} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col justify-between px-1.5 py-1.5">
          <span className="flex items-center justify-end gap-1" aria-hidden="true">
            {option.current && (
              <Check size={11} strokeWidth={2.6} style={{ color: c?.ink }} />
            )}
            <span className="size-1.5 rounded-full" style={{ background: c?.accent }} />
          </span>
          <span
            className="truncate text-micro font-medium"
            style={{ color: c?.ink ?? "var(--color-l2)" }}
          >
            {option.family}
          </span>
        </span>
      </span>
    </button>
  );
}

const icon = (I: typeof Search) => (
  <I size={14} strokeWidth={1.8} aria-hidden="true" />
);

/** 默认列表里最近项目只列这么多，其余搜得到 */
const RECENT_PROJECTS = 5;

/** 主题色样只从 App.css 文本解析（不临时切 data-theme 读计算值，见 theme-swatch.ts）；
 *  CSS 文本按需懒加载，面板首次打开后缓存 */
let swatchCache: Record<string, ThemeSwatch> | null = null;

function systemIsDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

/**
 * ⌘K 命令面板（浮层，边框按浮层规则保留）。默认列表：快速操作 / 最近项目 / 页面 / 外观 / 帮助；
 * 设置分区、单个主题、较早的项目只在搜索时出现。「切换主题…」进主题网格（与设置页主题卡同长相，
 * 方向键四向移动、标当前），⌫（空输入）或 Esc 退回。↑↓ 循环移动、Enter 执行（输入法组词中的 Enter 不算）、Esc 或点遮罩关闭。
 */
export default function CommandPalette({
  onClose,
  onQuickChat,
  onHelp,
}: {
  onClose: () => void;
  /** 「新对话」（原名快速开聊）：直接开一个空白随手聊（quick-chat-launch.ts openQuickChat，与侧栏同一入口） */
  onQuickChat: () => void;
  /** 反馈 / 诊断 / 检查更新 / 关于：与顶栏帮助菜单同一批弹窗 */
  onHelp: (target: PaletteHelpTarget) => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const settings = useAppStore((s) => s.settings);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const toggleChromeHidden = useAppStore((s) => s.toggleChromeHidden);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"root" | "theme">("root");
  const [index, setIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [swatches, setSwatches] = useState<Record<string, ThemeSwatch> | null>(swatchCache);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // 输入法：确认候选的 Enter 在 WKWebView 上可能落在 compositionend 之后，组词起锁、结束后留一帧
  const composingRef = useRef(false);
  // 纯 dismiss（Esc/遮罩）播 150ms 退场再交给父级卸载；选中命令走 commit 立即执行
  const { dismiss, exiting } = useAnimatedDismiss(onClose);

  useEffect(() => {
    let alive = true;
    // list_projects 已按最近打开降序
    invoke<ProjectDto[]>("list_projects")
      .then((list) => alive && setProjects(list))
      .catch(() => {});
    if (!swatchCache) {
      import("../App.css?raw")
        .then((m) => {
          const colors = parseThemeSwatchesFromCss(m.default);
          swatchCache = Object.fromEntries(THEMES.map((t) => [t.id, themeSwatchFor(t.id, colors)]));
          if (alive) setSwatches(swatchCache);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  const followSystem = settings?.themeFollowSystem === true;
  const customCards = normalizeCustomThemeCards(settings?.customThemes);
  const currentThemeKey = isCustomThemeId(settings?.theme)
    ? (() => {
        const card = resolveCustomThemeCardId(customCards, settings?.customThemeCardId);
        return card ? `card:${card}` : "custom";
      })()
    : (settings?.theme ?? DEFAULT_THEME_ID);
  const currentThemeName =
    currentThemeKey === "custom"
      ? "自定义"
      : currentThemeKey.startsWith("card:")
        ? (customCards.find((c) => `card:${c.id}` === currentThemeKey)?.name ?? "自定义")
        : (THEMES.find((t) => t.id === currentThemeKey)?.name ?? currentThemeKey);

  /** 主题选项单一出处：根列表的搜索条目（「主题：琥珀 · 浅」）与主题网格共用 */
  const themeOptions = (): ThemeOption[] => {
    const builtin: ThemeOption[] = THEMES.map((t) => {
      const light = "light" in t && t.light;
      const sw = swatches?.[t.id];
      return {
        key: `theme:${t.id}`,
        family: t.name.replace(/ · 浅$/, ""),
        fullName: t.name,
        group: light ? "浅色" : "深色",
        light,
        colors: sw
          ? { rail: sw.rail, canvas: sw.canvas, accent: sw.accent, ink: sw.ink }
          : null,
        keywords: [t.id, t.name],
        current: currentThemeKey === t.id,
        apply: () => {
          // 跟随系统时只选配色，深浅交给系统（与设置页主题卡同口径）
          const id = followSystem ? followedTheme(t.id, systemIsDark()) : t.id;
          void updateSettings({ theme: id, customThemeCardId: "" });
        },
      };
    });
    const customTile = (
      key: string,
      name: string,
      seeds: CustomThemeSeeds,
      cardId: string,
      keywords: string[],
    ): ThemeOption => {
      const tokens = deriveThemeTokens(seeds).tokens;
      return {
        key,
        family: name,
        fullName: name,
        group: "自定义",
        light: false,
        colors: { rail: tokens.rail, canvas: tokens.canvas, accent: tokens.cta, ink: tokens.l1 },
        keywords,
        current: currentThemeKey === (cardId ? `card:${cardId}` : "custom"),
        apply: () =>
          void updateSettings({
            theme: customThemeIdFromSeeds(seeds),
            customTheme: seeds,
            customThemeCardId: cardId,
          }),
      };
    };
    const savedCustom = normalizeCustomTheme(settings?.customTheme) ?? DEFAULT_CUSTOM_THEME;
    return [
      ...builtin,
      customTile("theme:custom", "自定义", savedCustom, "", ["custom", "自定义", "diy", "zidingyi"]),
      ...customCards.map((card) =>
        customTile(
          `theme:card:${card.id}`,
          card.name,
          { rail: card.rail, canvas: card.canvas, accent: card.accent },
          card.id,
          ["custom", "自定义", "色卡", card.id],
        ),
      ),
    ];
  };

  const searching = query.trim().length > 0;
  const pageSwitchOn = settings?.hotkeyPageSwitch !== false;
  const chromeCombo = settings?.hotkeyHideChrome ?? "mod+\\";
  const openExternal = (url: string) =>
    openUrl(url).catch(() => toast("浏览器没打开，稍后再试", "warning"));

  const entries: Entry[] =
    mode === "theme"
      ? []
      : [
          {
            cmd: {
              id: "quick-chat",
              title: "新对话",
              group: "快速操作",
              keywords: ["chat", "聊", "开聊", "随便聊", "quick", "new", "新会话", "新聊天", "快速开聊", "xindh", "xdh", "kuaisu", "kslt"],
            },
            icon: icon(NAV_ICONS.quickChat),
            run: onQuickChat,
          },
          {
            cmd: {
              id: "project:new",
              title: "新建项目…",
              group: "快速操作",
              keywords: ["new", "project", "新建", "创建", "项目", "xinjian"],
            },
            icon: icon(FolderPlus),
            run: () => {
              const s = useAppStore.getState();
              s.setPage("workspaces");
              s.setNewProjectOpenReq({ token: Date.now() });
            },
          },
          {
            cmd: {
              id: "project:add",
              title: "添加已有文件夹…",
              group: "快速操作",
              keywords: ["add", "folder", "open", "添加", "打开", "文件夹", "导入", "项目"],
            },
            icon: icon(FolderOpen),
            run: () => {
              const s = useAppStore.getState();
              s.setPage("workspaces");
              s.setAddProjectOpenReq(Date.now());
            },
          },
          {
            cmd: {
              id: "phone-drop",
              title: "从手机添加…",
              group: "快速操作",
              keywords: ["phone", "mobile", "手机", "扫码", "上传", "传文件", "照片", "拍照", "shouji", "sj"],
            },
            icon: icon(Smartphone),
            run: () => usePhoneDropStore.getState().openDialog(null),
          },
          ...(appUpdate
            ? [
                {
                  cmd: {
                    id: "app-update",
                    title: `安装 Mesa v${appUpdate.version}`,
                    group: "快速操作",
                    keywords: ["update", "更新", "升级", "安装", "gengxin"],
                  },
                  icon: icon(Download),
                  run: () => onHelp("update"),
                },
              ]
            : []),
          ...projects.map((p, i) => ({
            cmd: {
              id: `project:${p.path}`,
              title: p.name,
              group: searching ? "项目" : "最近项目",
              hint: WORK_MODE_LABEL[normalizeWorkMode(p.workMode)],
              keywords: [p.path, "项目", "project"],
              searchOnly: i >= RECENT_PROJECTS,
            },
            icon: icon(FolderClosed),
            run: () => {
              const s = useAppStore.getState();
              s.setSelectProjectReq(p.path);
              s.setPage("workspaces");
            },
          })),
          ...PAGE_HOTKEY_DEFS.map((p) => {
            const combo = settings?.hotkeyPages?.[p.id] ?? p.combo;
            return {
              cmd: {
                id: `page:${p.id}`,
                title: p.label,
                group: "页面",
                hint: pageSwitchOn && combo ? comboLabel(combo) : undefined,
                keywords: [p.id, "页面", "page"],
              },
              icon: icon(NAV_ICONS[p.id]),
              kbd: true,
              run: () => setPage(p.id),
            };
          }),
          {
            cmd: {
              id: "theme:pick",
              title: "切换主题…",
              group: "外观",
              hint: currentThemeName,
              keywords: ["theme", "主题", "配色", "颜色", "深色", "浅色", "dark", "light", "zhuti"],
            },
            icon: icon(Palette),
            keepOpen: true,
            run: () => {
              setMode("theme");
              setQuery("");
            },
          },
          {
            cmd: {
              id: "chrome:toggle",
              title: chromeHidden ? "显示侧栏" : "隐藏侧栏",
              group: "外观",
              hint: chromeCombo ? comboLabel(chromeCombo) : undefined,
              keywords: ["sidebar", "侧栏", "导航", "chrome", "全屏", "专注"],
            },
            icon: icon(chromeHidden ? PanelLeftOpen : PanelLeftClose),
            kbd: true,
            run: toggleChromeHidden,
          },
          ...themeOptions().map((o) => ({
            cmd: {
              id: o.key,
              title: `主题：${o.fullName}`,
              group: "外观",
              hint: o.current ? "当前" : undefined,
              keywords: ["theme", "主题", "zhuti", ...o.keywords],
              searchOnly: true,
            },
            swatch: o.colors,
            current: o.current,
            run: o.apply,
          })),
          {
            cmd: {
              id: "help:guide",
              title: "上手引导",
              group: "帮助",
              keywords: ["onboarding", "guide", "上手", "引导", "新手", "入门", "第一次", "shangshou"],
            },
            icon: icon(Compass),
            run: () => openOnboardingGuide(),
          },
          {
            cmd: {
              id: "help:feedback",
              title: "反馈与提需求",
              group: "帮助",
              keywords: ["feedback", "bug", "反馈", "需求", "建议", "缺陷", "问题", "fankui"],
            },
            icon: icon(Megaphone),
            run: () => onHelp("feedback"),
          },
          {
            cmd: {
              id: "help:diag",
              title: "诊断与日志",
              group: "帮助",
              keywords: ["diagnostics", "log", "诊断", "日志", "报错", "错误", "zhenduan"],
            },
            icon: icon(Activity),
            run: () => onHelp("diag"),
          },
          {
            cmd: {
              id: "help:update",
              title: "检查更新",
              group: "帮助",
              keywords: ["update", "upgrade", "更新", "升级", "版本", "gengxin"],
            },
            icon: icon(RefreshCw),
            run: () => onHelp("update"),
          },
          {
            cmd: {
              id: "help:about",
              title: "关于 Mesa",
              group: "帮助",
              keywords: ["about", "version", "关于", "版本", "许可", "license"],
            },
            icon: icon(Info),
            run: () => onHelp("about"),
          },
          {
            cmd: {
              id: "help:tutorial",
              title: "使用教程",
              group: "帮助",
              keywords: ["tutorial", "教程", "入门", "上手", "jiaocheng"],
              searchOnly: true,
            },
            icon: icon(BookOpen),
            external: true,
            run: () => void openExternal(`${REPO_URL}/blob/main/docs/guide/tutorial.md`),
          },
          {
            cmd: {
              id: "help:guide",
              title: "产品说明书",
              group: "帮助",
              keywords: ["guide", "manual", "docs", "说明书", "文档", "手册", "帮助"],
              searchOnly: true,
            },
            icon: icon(BookText),
            external: true,
            run: () => void openExternal(userGuideUrl()),
          },
          {
            cmd: {
              id: "help:security",
              title: "报告安全问题",
              group: "帮助",
              keywords: ["security", "安全", "漏洞"],
              searchOnly: true,
            },
            icon: icon(ShieldAlert),
            external: true,
            run: () => void openExternal(`${REPO_URL}/security`),
          },
          ...SETTINGS_SEARCH_INDEX.map((s) => ({
            cmd: {
              id: `settings:${s.id}`,
              title: `设置：${s.label}`,
              group: "设置",
              keywords: [s.id, "设置", "settings", ...s.aliases],
              searchOnly: true,
            },
            icon: icon(Settings2),
            run: () => {
              setSettingsSectionReq(s.id);
              setPage("settings");
            },
          })),
        ];

  // 几十条命令，每次渲染直接重算即可（条目依赖 settings / 项目 / 查询，记忆化反而易漏依赖）
  const byId = new Map(entries.map((e) => [e.cmd.id, e]));
  const filtered = filterCommands(entries.map((e) => e.cmd), query);

  // 主题网格：跟随系统时只列与系统同深浅的一套（选的是配色，深浅交给系统）；自定义不随系统，总列出
  const themeQuery = query.trim().toLowerCase();
  const sysDark = systemIsDark();
  const tiles =
    mode === "theme"
      ? themeOptions().filter(
          (o) =>
            (!followSystem || o.group === "自定义" || o.light === !sysDark) &&
            (!themeQuery ||
              [o.family, o.fullName, ...o.keywords].some((k) => k.toLowerCase().includes(themeQuery))),
        )
      : [];
  const tileGroup = (o: ThemeOption) => (followSystem && o.group !== "自定义" ? "配色" : o.group);
  // 网格行（存格下标）：换组或满 7 格换行——↑↓ 按同列跳行，深色格往下正好落到同名浅色
  const tileRows: number[][] = [];
  tiles.forEach((o, i) => {
    const last = tileRows[tileRows.length - 1];
    if (!last || last.length >= THEME_COLS || tileGroup(tiles[last[0]]) !== tileGroup(o)) {
      tileRows.push([i]);
    } else {
      last.push(i);
    }
  });
  const moveInGrid = (key: string) => {
    const n = tiles.length;
    if (!n) return;
    if (key === "ArrowRight") setIndex((i) => (i + 1) % n);
    else if (key === "ArrowLeft") setIndex((i) => (i - 1 + n) % n);
    else {
      const r = Math.max(0, tileRows.findIndex((row) => row.includes(index)));
      const c = Math.max(0, tileRows[r].indexOf(index));
      const nr =
        key === "ArrowDown" ? (r + 1) % tileRows.length : (r - 1 + tileRows.length) % tileRows.length;
      const row = tileRows[nr];
      setIndex(row[Math.min(c, row.length - 1)]);
    }
  };

  const runAt = (i: number) => {
    if (mode === "theme") {
      const tile = tiles[i];
      if (!tile) return;
      onClose();
      tile.apply();
      return;
    }
    const item = filtered[i];
    const entry = item && byId.get(item.id);
    if (!entry) return;
    if (!entry.keepOpen) onClose();
    entry.run();
  };

  // 打开即聚焦输入框
  useEffect(() => inputRef.current?.focus(), []);
  // 查询或层级变化回到首项；进主题网格时停在当前主题上
  useEffect(() => {
    if (mode === "theme" && !query.trim()) {
      setIndex(Math.max(tiles.findIndex((o) => o.current), 0));
    } else {
      setIndex(0);
    }
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);
  // 键盘移到可视区外时跟着滚
  useEffect(() => {
    (mode === "theme" ? gridRef.current : listRef.current)
      ?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, mode]);

  const backToRoot = () => {
    setMode("root");
    setQuery("");
  };

  const footerNote =
    mode === "theme"
      ? followSystem
        ? "已开「跟随系统深浅」：只选配色，深浅随系统"
        : "Agent 会话配色按启动时的终端底色定，已开的会话重开后生效"
      : searching
        ? `${filtered.length} 个结果`
        : "";

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/40 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className={`ccode-command-palette ccode-anchor-top mt-[10vh] h-fit w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-xl border border-field ccode-float-surface${exiting ? " ccode-exiting" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3.5">
          <Search size={15} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
          {mode === "theme" && (
            <button
              type="button"
              onClick={backToRoot}
              title="返回全部命令（⌫）"
              className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-l2 hover:text-l1"
            >
              {/* 全站 button { font: inherit }：字号挂在内层 */}
              <span className="text-xs">主题</span>
            </button>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              requestAnimationFrame(() => {
                composingRef.current = false;
              });
            }}
            onKeyDown={(e) => {
              const n = filtered.length;
              if (
                mode === "theme" &&
                ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)
              ) {
                e.preventDefault();
                moveInGrid(e.key);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (n) setIndex((i) => (i + 1) % n);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (n) setIndex((i) => (i - 1 + n) % n);
              } else if (e.key === "Enter") {
                // 组词中 / 确认候选的那次 Enter 只上屏，不执行命令
                if (
                  imeBlocksEnter({
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.keyCode,
                    composingLock: composingRef.current,
                  })
                ) {
                  return;
                }
                e.preventDefault();
                if (!exiting) runAt(index);
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (mode === "theme") backToRoot();
                else dismiss();
              } else if (e.key === "Backspace" && mode === "theme" && !query) {
                e.preventDefault();
                backToRoot();
              }
            }}
            placeholder={mode === "theme" ? "选一个主题…" : "搜索命令、项目、页面或设置…"}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4"
          />
          <kbd className="rounded border border-field px-1.5 py-0.5 font-mono text-micro text-l4">Esc</kbd>
        </div>
        {mode === "theme" ? (
          <div ref={gridRef} className="max-h-[400px] overflow-auto px-3 pb-3">
            {tiles.length === 0 && (
              <p className="py-8 text-center text-xs text-l4">没有匹配「{query.trim()}」的主题</p>
            )}
            {[...new Set(tiles.map(tileGroup))].map((label) => (
              <section key={label}>
                <div className="pb-1.5 pt-2.5 text-micro text-l3">{label}</div>
                <div className="grid grid-cols-7 gap-1.5 p-0.5">
                  {tiles.map((o, i) =>
                    tileGroup(o) === label ? (
                      <PaletteThemeTile
                        key={o.key}
                        option={o}
                        idx={i}
                        active={i === index}
                        onPick={() => runAt(i)}
                        onHover={() => {
                          if (i !== index) setIndex(i);
                        }}
                      />
                    ) : null,
                  )}
                </div>
              </section>
            ))}
          </div>
        ) : (
        <ul ref={listRef} className="max-h-[400px] overflow-auto p-1">
          {filtered.map((c, i) => {
            const entry = byId.get(c.id);
            const selected = i === index;
            // 设置分区靠别名搜到时，行尾标出命中的词（其余命令的别名多是拼音/英文，不展示）
            const hint = c.id.startsWith("settings:") ? (matchedKeyword(c, query) ?? c.hint) : c.hint;
            return (
              <li key={c.id}>
                {(i === 0 || filtered[i - 1]?.group !== c.group) && c.group && (
                  <div className="px-2.5 pb-1 pt-2 text-micro text-l3">{c.group}</div>
                )}
                <button
                  type="button"
                  data-idx={i}
                  onClick={() => runAt(i)}
                  // 用 mousemove 而不是 mouseenter：键盘滚动列表时，停着的鼠标不该把选中抢走
                  onMouseMove={() => {
                    if (!selected) setIndex(i);
                  }}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors ${
                    selected ? "bg-seg-sel text-l1" : "text-l2"
                  }`}
                >
                  <span
                    className={`flex w-4 shrink-0 items-center justify-center ${selected ? "text-l2" : "text-l3"}`}
                  >
                    {entry?.swatch ? (
                      <span
                        aria-hidden="true"
                        className="flex h-3.5 w-4 overflow-hidden rounded-xs border border-field"
                      >
                        <span className="w-1.5" style={{ background: entry.swatch.rail }} />
                        <span
                          className="flex flex-1 items-center justify-center"
                          style={{ background: entry.swatch.canvas }}
                        >
                          <span
                            className="size-1 rounded-full"
                            style={{ background: entry.swatch.accent }}
                          />
                        </span>
                      </span>
                    ) : (
                      entry?.icon
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {entry?.current ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-l3">
                      <Check size={13} strokeWidth={2} aria-hidden="true" />
                      当前
                    </span>
                  ) : (
                    hint && (
                      <span
                        className={`max-w-[40%] shrink-0 truncate text-xs text-l4 ${entry?.kbd ? "font-mono" : ""}`}
                      >
                        {hint}
                      </span>
                    )
                  )}
                  {entry?.external && (
                    <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
                  )}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3.5 py-8 text-center text-xs text-l4">
              没有匹配「{query.trim()}」的命令
            </li>
          )}
        </ul>
        )}
        <div className="flex items-center gap-3 border-t border-hairline px-3.5 py-1.5 text-micro text-l4">
          <span>
            <kbd className="font-mono text-l3">{mode === "theme" ? "←→↑↓" : "↑↓"}</kbd> 选择
          </span>
          <span>
            <kbd className="font-mono text-l3">↵</kbd> {mode === "theme" ? "应用" : "执行"}
          </span>
          {mode === "theme" && (
            <span>
              <kbd className="font-mono text-l3">⌫</kbd> 返回
            </span>
          )}
          {footerNote && <span className="ml-auto min-w-0 truncate">{footerNote}</span>}
        </div>
      </div>
    </div>
  );
}
