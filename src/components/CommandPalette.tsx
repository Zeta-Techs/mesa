import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useAppStore } from "../store";
import { filterCommands, type PaletteCommand } from "../command-palette";
import { THEMES } from "../themes";
import {
  customThemeIdFromSeeds,
  DEFAULT_CUSTOM_THEME,
  normalizeCustomTheme,
  normalizeCustomThemeCards,
} from "../custom-theme";
import { comboLabel } from "../hotkeys";
import { useAnimatedDismiss } from "../exit-animation";

const PAGE_COMMANDS: {
  id: string;
  label: string;
  hint: string;
}[] = [
  { id: "workbench", label: "工作台", hint: comboLabel("mod+1") },
  { id: "workspaces", label: "项目", hint: comboLabel("mod+2") },
  { id: "terminal", label: "运行", hint: comboLabel("mod+3") },
  { id: "sessions", label: "对话", hint: comboLabel("mod+4") },
  { id: "profiles", label: "连接", hint: comboLabel("mod+5") },
  { id: "skills", label: "技能", hint: comboLabel("mod+6") },
  { id: "mcp", label: "MCP", hint: comboLabel("mod+7") },
  { id: "stats", label: "用量", hint: comboLabel("mod+8") },
  { id: "settings", label: "设置", hint: comboLabel("mod+9") },
];

/**
 * ⌘K 命令面板（浮层，边框按浮层规则保留）：页面跳转 / 主题切换 / 侧栏显隐。
 * ↑↓ 移动、Enter 执行、Esc 或点遮罩关闭；执行后一律关闭。
 */
export default function CommandPalette({
  onClose,
  onQuickChat,
}: {
  onClose: () => void;
  /** 「快速开聊」弹层由 App 承载（侧栏入口共用同一个宿主） */
  onQuickChat: () => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const settings = useAppStore((s) => s.settings);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const toggleChromeHidden = useAppStore((s) => s.toggleChromeHidden);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 纯 dismiss（Esc/遮罩）播 150ms 退场再交给父级卸载；选中命令走 commit 立即执行
  const { dismiss, exiting } = useAnimatedDismiss(onClose);

  const commands = useMemo<{ cmd: PaletteCommand; run: () => void }[]>(
    () => [
      {
        cmd: {
          id: "quick-chat",
          title: "＋ 快速开聊",
          group: "快速操作",
          keywords: ["chat", "聊", "开聊", "随便聊", "quick", "新会话", "kuaisu"],
        },
        run: onQuickChat,
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
              run: () => {
                setSettingsSectionReq("update");
                setPage("settings");
              },
            },
          ]
        : []),
      ...PAGE_COMMANDS.map((p) => ({
        cmd: {
          id: `page:${p.id}`,
          title: p.label,
          group: "页面",
          hint: p.hint,
          keywords: [p.id, p.label, "页面", "page"],
        },
        run: () => setPage(p.id),
      })),
      ...THEMES.map((t) => ({
        cmd: {
          id: `theme:${t.id}`,
          title: `主题：${t.name}`,
          group: "外观",
          keywords: ["theme", "主题", t.id, t.name],
        },
        run: () =>
          void updateSettings({ theme: t.id, customThemeCardId: "" }),
      })),
      {
        cmd: {
          id: "theme:custom",
          title: "主题：自定义",
          group: "外观",
          keywords: ["theme", "主题", "custom", "自定义", "diy", "zidingyi"],
        },
        run: () => {
          const seeds =
            normalizeCustomTheme(settings?.customTheme) ?? DEFAULT_CUSTOM_THEME;
          void updateSettings({
            theme: customThemeIdFromSeeds(seeds),
            customTheme: seeds,
            customThemeCardId: "",
          });
        },
      },
      ...normalizeCustomThemeCards(settings?.customThemes).map((card) => ({
        cmd: {
          id: `theme:card:${card.id}`,
          title: `主题：${card.name}`,
          group: "外观",
          keywords: ["theme", "主题", "custom", "自定义", "色卡", card.name, card.id],
        },
        run: () => {
          const seeds = {
            rail: card.rail,
            canvas: card.canvas,
            accent: card.accent,
          };
          void updateSettings({
            theme: customThemeIdFromSeeds(seeds),
            customTheme: seeds,
            customThemeCardId: card.id,
          });
        },
      })),
      {
        cmd: {
          id: "chrome:toggle",
          title: chromeHidden ? "显示侧栏" : "隐藏侧栏",
          group: "外观",
          hint: "⌘\\",
          keywords: ["sidebar", "侧栏", "chrome"],
        },
        run: toggleChromeHidden,
      },
    ],
    [
      setPage,
      setSettingsSectionReq,
      appUpdate,
      updateSettings,
      settings,
      chromeHidden,
      toggleChromeHidden,
      onQuickChat,
    ],
  );

  const filtered = useMemo(
    () => filterCommands(commands.map((c) => c.cmd), query),
    [commands, query],
  );

  const runAt = (i: number) => {
    const item = filtered[i];
    if (!item) return;
    onClose();
    commands.find((c) => c.cmd.id === item.id)?.run();
  };

  // 打开即聚焦输入框；查询变化回到首行
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

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
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (!exiting) runAt(index);
              } else if (e.key === "Escape") {
                e.preventDefault();
                dismiss();
              }
            }}
            placeholder="跳转页面、换主题或管理侧栏…"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4"
          />
          <kbd className="rounded border border-field px-1.5 py-0.5 font-mono text-micro text-l4">Esc</kbd>
        </div>
        <ul className="max-h-[400px] overflow-auto p-1">
          {filtered.map((c, i) => (
            <li key={c.id}>
              {(i === 0 || filtered[i - 1]?.group !== c.group) && c.group && (
                <div className="px-2.5 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-[0.08em] text-l4">
                  {c.group}
                  {/* 外观组带一句主题切换说明（与设置页主题区同口径）：Agent TUI 配色
                      只在启动时探测终端底色（OSC 11），运行中会话重启后才会一致 */}
                  {c.group === "外观" && (
                    <div className="mt-0.5 normal-case tracking-normal text-l4">
                      Agent 会话配色按启动时终端底色确定，运行中会话重启后生效
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => runAt(i)}
                onMouseEnter={() => setIndex(i)}
                className={`flex h-8 w-full items-center gap-2 rounded-md border-l-2 px-2.5 text-left text-sm transition-colors ${
                  i === index ? "border-cta bg-seg-sel text-l1" : "border-transparent text-l2 hover:bg-hover"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.hint && (
                  <span className="shrink-0 font-mono text-xs text-l4">
                    {c.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3.5 py-8 text-center text-xs text-l4">没有匹配的命令</li>
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-hairline px-3.5 py-1.5 text-micro text-l4">
          <span><kbd className="font-mono text-l3">↑↓</kbd> 选择</span>
          <span><kbd className="font-mono text-l3">↵</kbd> 执行</span>
          <span className="ml-auto">{filtered.length} 个命令</span>
        </div>
      </div>
    </div>
  );
}
