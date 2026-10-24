import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "./ConfirmDialog";
import { useMenuKeyNav } from "../menu-key-nav";
import { clipBounds, pickPopoverSide } from "../popover-side";
import { permissionExample } from "../chat-permission";
import type { StarterContext } from "../chat-empty-start";
import type { CliPermissionNote, NativePermissionMode } from "../pages/TerminalPage";

type Permission = "discuss" | "write_tree";
export type PermissionTier = "discuss" | NativePermissionMode;
type Tier = PermissionTier;

/** 四档的名字与说明：聊天输入框左下的菜单、终端启动栏「权限」格、「这次启动」信息卡共用 */
export const PERMISSION_TIERS: { id: Tier; label: string; desc: string }[] = [
  { id: "discuss", label: "只讨论", desc: "只看、只说，不改文件、不跑命令" },
  { id: "ask", label: "请求批准", desc: "改文件、跑命令前都先问你" },
  { id: "auto", label: "帮我批准", desc: "日常操作自动放行，有风险才问你" },
  { id: "full", label: "完全访问", desc: "改文件、跑命令都不再问你" },
];

/**
 * 权限符号「界线」（2026-10-22 用户选定方案 A，不与 Codex 的眼睛 / 手掌 / 盾牌撞）：竖线是「要你点头的那条线」，
 * 小块是 Mesa 的光标（M▁ 那一道）。空心块停在线外 = 只看不动；实心块抵住线 = 到线前先问；
 * 线只剩上半截、块从下面过去 = 日常的自己过；线没了、块走远 = 不再问。颜色跟随文字（完全访问由调用方染 caution）
 */
export function PermissionGlyph({ tier, className = "" }: { tier: Tier | null; className?: string }) {
  const block = (x: number, hollow = false) =>
    hollow ? (
      <rect x={x} y="9.6" width="7" height="4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    ) : (
      <rect x={x} y="9.6" width="7" height="4" rx="1.2" fill="currentColor" />
    );
  const wall = <path d="M13 2v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />;
  return (
    <svg viewBox="0 0 20 16" width="17" height="14" aria-hidden="true" className={`shrink-0 ${className}`}>
      {tier === "discuss" && (
        <>
          {wall}
          {block(2.6, true)}
        </>
      )}
      {(tier === "ask" || tier === null) && (
        <>
          {wall}
          {block(4.6)}
        </>
      )}
      {tier === "auto" && (
        <>
          <path d="M13 2v6" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2 2" />
          {block(9.5)}
        </>
      )}
      {tier === "full" && (
        <>
          <path d="M1.5 11.6h8" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.5 2" opacity="0.6" />
          {block(12.6)}
        </>
      )}
    </svg>
  );
}

/**
 * 换到某一档前要不要确认：完全访问一律二次确认（danger）；Agent 正在运行时换任何一档都要说明「会重开」。
 * 返回 false = 用户取消。聊天输入框与终端启动栏 / 「这次启动」卡同一套话术。
 */
export async function confirmPermissionChoice(
  agentLabel: string,
  id: PermissionTier,
  live: boolean,
): Promise<boolean> {
  const restartNote = live
    ? `\n\n权限在启动时定下，换权限要重开：Mesa 会停下 ${agentLabel}，再带着新权限接回原来这段对话，聊过的内容不会丢。`
    : "";
  if (id === "full") {
    return confirmDialog(
      `开启完全访问？\n\n这次对话里，${agentLabel} 改文件、跑命令都不会先问你，包括删除文件、安装软件这类操作；出了错没有人拦。\n\n只对这一次对话生效，不改 ${agentLabel} 的本机设置。不确定就选「帮我批准」。${restartNote}`,
      { danger: true, confirmText: "开启完全访问" },
    );
  }
  if (!live) return true;
  return confirmDialog(
    `换成「${PERMISSION_TIERS.find((t) => t.id === id)?.label}」？${restartNote}`,
    { confirmText: "重开并换权限" },
  );
}

/** 实际生效的那一档：手动选的 > 本机设置对应的；都没有 = 不知道 */
export function effectivePermissionTier(
  permission: Permission,
  mode: NativePermissionMode | null,
  note: CliPermissionNote | null,
): Tier | null {
  return permission === "discuss" ? "discuss" : (mode ?? note?.tier ?? null);
}

/**
 * 聊天输入框左下的权限徽标与菜单（docs/design-chat-layer.md §4.2；2026-10-22 第二版设计稿重做）。
 * 后三档是各家 CLI 的原生启动参数（agent_specs permission_args），只加在本次命令行、不改 CLI 配置；这家没有的档置灰。
 * 用户没手动选过 = 按本机设置启动：本机设置对应的那档标「本机设置」（cli_permission.rs 只读探查）。
 * 菜单不再是「图标 + 标题 + 说明 + 勾」（那是 Codex 的样子）：拿一件具体的事说明四档（示例按项目类型取，
 * chat-permission.ts），每档一行，选中靠整行铺 seg 底；符号是 Mesa 自己的「界线」。
 * 开聊后也能换：权限在启动参数里，换 = 停下 Agent、带新参数接回原对话（live.onRestart）；生成中不让换。
 */
export default function ChatPermissionBadge({
  agentLabel,
  permission,
  mode,
  modes,
  readonlySupported,
  note,
  editable,
  onPermission,
  live = null,
  context = "general",
  cycleHint = false,
  flash = false,
}: {
  agentLabel: string;
  permission: Permission;
  /** 手动选的原生档；null = 按本机设置 */
  mode: NativePermissionMode | null;
  /** 这家能指定的原生档（DetectResult.permissionModes） */
  modes: string[];
  readonlySupported: boolean;
  note: CliPermissionNote | null;
  editable: boolean;
  onPermission?: (permission: Permission, mode?: NativePermissionMode | null) => void;
  /** Agent 正在运行：换权限要重开（busy = 这一轮还在生成，等它结束再换） */
  live?: { busy: boolean; onRestart: () => void } | null;
  /** 这段对话在哪类项目里：菜单拿哪件事举例 */
  context?: StarterContext;
  /** 输入框里 ⇧Tab 能轮换（开聊前）：菜单底部提一句 */
  cycleHint?: boolean;
  /** 刚切到完全访问：和输入框上沿那道细线同一次亮起、同一条曲线淡回灰字（useToneFlash） */
  flash?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuKeyNav(menuRef, open);
  const [side, setSide] = useState<"above" | "below">("above");
  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return;
    setSide(
      pickPopoverSide(
        rootRef.current.getBoundingClientRect(),
        clipBounds(rootRef.current),
        menuRef.current.offsetHeight,
      ),
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // 变成只显示（开始生成 / 不可改）时收起弹层，免得恢复可点时弹层带着旧状态冒出来
  const interactive = !live?.busy && (editable || Boolean(live));
  useEffect(() => {
    if (!interactive) setOpen(false);
  }, [interactive]);

  const followsLocal = permission !== "discuss" && mode === null;
  const current = effectivePermissionTier(permission, mode, note);
  const available = (id: Tier) => (id === "discuss" ? readonlySupported : modes.includes(id));
  const cur = PERMISSION_TIERS.find((t) => t.id === current) ?? null;
  const label = cur?.label ?? (followsLocal && note ? note.short : "默认权限");
  const loud = current === "full";
  const explain = followsLocal && note ? note.detail : (cur?.desc ?? `按 ${agentLabel} 自己的权限设置`);
  const ex = permissionExample(context);

  async function choose(id: Tier) {
    setOpen(false);
    if (id === current) {
      // 点的就是本机设置对应的那档：改成用参数固定（以后本机设置变了这段对话也不跟着变）；生效的权限没变，不重开
      if (followsLocal && id !== "discuss") onPermission?.("write_tree", id);
      return;
    }
    if (!(await confirmPermissionChoice(agentLabel, id, Boolean(live)))) return;
    if (id === "discuss") onPermission?.("discuss", null);
    else onPermission?.("write_tree", id);
    live?.onRestart();
  }

  // 灰字（2026-10-23 用户：照 Claude 客户端，Bypass 也是灰的）。完全访问只在切到的那一下亮 caution，
  // 和输入框上沿细线同步淡掉（App.css .ccode-perm-flash）
  const chip = `ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-l3 ${
    loud && flash ? "ccode-perm-flash" : ""
  }`;

  if (!interactive) {
    return (
      <span
        className={chip}
        title={live?.busy ? `${explain}\n正在生成，等这一轮结束再换权限` : explain}
      >
        <PermissionGlyph tier={current} />
        {label}
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          live
            ? `${explain}\n点击换权限（会停下 Agent，再带新权限接回这段对话）`
            : `${explain}\n点击选择这次的权限${cycleHint ? "（输入框里 ⇧Tab 也能换）" : ""}`
        }
        className={`${chip} hover:bg-hover hover:text-l1 ${open ? "bg-hover" : ""}`}
      >
        <PermissionGlyph tier={current} />
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="AI 动手前怎么问你"
          // 字号挂在容器上：全站 button { font: inherit } 会吞掉按钮自己的 text-*
          className={`absolute left-0 z-30 w-[21rem] rounded-xl border border-field ccode-float-surface p-1 text-sm shadow-lg whitespace-normal ${
            side === "below" ? "top-full mt-2" : "bottom-full mb-2"
          }`}
        >
          <div className="flex items-center gap-1 px-2 pb-1 pt-1 text-xs text-l4">
            假如它要{ex.verb}
            <code className="rounded-sm bg-inset px-1 font-mono text-micro text-l3">{ex.target}</code>
          </div>
          {PERMISSION_TIERS.map((t) => {
            const ok = available(t.id);
            const selected = current === t.id;
            const danger = t.id === "full";
            return (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={!ok}
                onClick={() => void choose(t.id)}
                title={ok ? t.desc : undefined}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected ? "bg-seg-sel text-l1" : "text-l2 hover:bg-hover hover:text-l1 focus-visible:bg-hover"
                }`}
              >
                <PermissionGlyph tier={t.id} className={danger ? "text-caution-text" : selected ? "text-l2" : "text-l3"} />
                <span className="shrink-0">{t.label}</span>
                {followsLocal && note?.tier === t.id && (
                  <span className="shrink-0 rounded-sm bg-inset px-1 text-micro leading-4 text-l3">本机设置</span>
                )}
                <span className={`ml-auto min-w-0 truncate text-xs ${selected ? "text-l3" : "text-l4"}`}>
                  {ok ? ex.outcomes[t.id] : `${agentLabel} 没有这一档`}
                </span>
              </button>
            );
          })}
          <p className="mx-1 mt-1 flex items-start justify-between gap-2 border-t border-hairline px-1 pb-0.5 pt-1.5 text-micro leading-4 text-l4">
            <span>
              {followsLocal && note && !note.tier
                ? `现在按本机设置：${note.detail}。选一档只管这一段对话。`
                : `只管这一段对话，不改 ${agentLabel} 的设置。${live ? "开聊后换会重开并接回。" : ""}`}
            </span>
            {cycleHint && !live && (
              <span className="shrink-0 whitespace-nowrap">
                <kbd className="rounded-sm bg-inset px-1 font-mono text-l3">⇧Tab</kbd> 轮换
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
