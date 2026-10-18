import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Eye, Hand, ShieldAlert, ShieldCheck } from "lucide-react";
import { confirmDialog } from "./ConfirmDialog";
import { useMenuKeyNav } from "../menu-key-nav";
import { pickPopoverSide } from "../popover-side";
import type { CliPermissionNote, NativePermissionMode } from "../pages/TerminalPage";

type Permission = "discuss" | "write_tree";
export type PermissionTier = "discuss" | NativePermissionMode;
type Tier = PermissionTier;

/** 四档的名字与说明：聊天输入框左下的菜单、终端启动栏「权限」格、「这次启动」信息卡共用 */
export const PERMISSION_TIERS: { id: Tier; label: string; desc: string; Icon: typeof Eye }[] = [
  { id: "discuss", label: "只讨论", desc: "只看、只说，不改文件、不跑命令", Icon: Eye },
  { id: "ask", label: "请求批准", desc: "改文件、跑命令前都先问你", Icon: Hand },
  { id: "auto", label: "帮我批准", desc: "普通操作自动放行，有风险的才问你", Icon: ShieldCheck },
  { id: "full", label: "完全访问", desc: "改文件、跑命令都不问你，选时会再确认", Icon: ShieldAlert },
];

/**
 * 聊天输入框左下的权限徽标与菜单（docs/design-chat-layer.md §4.2，2026-10-17 照 ChatGPT「请求批准 / 帮我批准 /
 * 完全访问」收成四档）。后三档是各家 CLI 的原生启动参数（agent_specs permission_args），只加在本次命令行、不改 CLI 配置；
 * 这家没有的档置灰。用户没手动选过 = 按本机设置启动：本机设置对应的那档打勾并标「本机设置」（cli_permission.rs 只读探查），
 * 对应不上（如 Claude acceptEdits）就不打勾，菜单底部写本机设置原话。
 * 开聊后也能换：权限在启动参数里，换 = 停下 Agent、带新参数接回原对话（live.onRestart）；生成中不让换。
 * 2026-10-18 用户：去掉「了解更多」、弹层收小一号、下面放得下就往下开（popover-side.ts）。
 */
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
        window.innerHeight,
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
  // 实际生效的那一档：手动选的 > 本机设置对应的；都没有 = 不知道（不打勾）
  const current: Tier | null =
    permission === "discuss" ? "discuss" : (mode ?? note?.tier ?? null);
  const available = (id: Tier) => (id === "discuss" ? readonlySupported : modes.includes(id));
  const cur = PERMISSION_TIERS.find((t) => t.id === current) ?? null;
  const label = cur?.label ?? (followsLocal && note ? note.short : "默认权限");
  const Icon = cur?.Icon ?? Hand;
  const loud = current === "full";
  const explain = followsLocal && note ? note.detail : (cur?.desc ?? `按 ${agentLabel} 自己的权限设置`);

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

  const chip = `ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro ${
    loud ? "text-warn-text" : "text-l3"
  }`;

  if (!interactive) {
    return (
      <span
        className={chip}
        title={live?.busy ? `${explain}\n正在生成，等这一轮结束再换权限` : explain}
      >
        <Icon size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
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
            : `${explain}\n点击选择这次的权限`
        }
        className={`${chip} hover:bg-hover ${loud ? "" : "hover:text-l1"}`}
      >
        <Icon size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        {label}
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="AI 动手前怎么问你"
          className={`absolute left-0 z-30 w-[19rem] rounded-xl border border-field ccode-float-surface p-1 shadow-lg ${
            side === "below" ? "top-full mt-2" : "bottom-full mb-2"
          }`}
        >
          <div className="px-2 pb-1 pt-1 text-xs text-l3">AI 动手前怎么问你？</div>
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
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:opacity-40 ${
                  danger ? "text-warn-text" : ""
                }`}
              >
                <t.Icon
                  size={15}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  className={`mt-px shrink-0 ${danger ? "" : "text-l2"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm leading-5 ${danger ? "" : "text-l1"}`}>
                    {t.label}
                    {followsLocal && note?.tier === t.id && (
                      <span className="ml-1.5 text-micro text-l4">本机设置</span>
                    )}
                  </span>
                  <span className={`block text-xs leading-[18px] ${danger ? "" : "text-l3"}`}>
                    {ok ? t.desc : `${agentLabel} 没有这一档的启动参数`}
                  </span>
                </span>
                <Check
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${selected ? "text-l2" : "invisible"}`}
                />
              </button>
            );
          })}
          <p className="mx-1 mt-1 border-t border-hairline px-1 pb-0.5 pt-1.5 text-micro leading-4 text-l4">
            {followsLocal && note && !note.tier
              ? `现在按本机设置：${note.detail}。选一档后只对这次对话生效，不改 ${agentLabel} 的配置。`
              : `只作用于这次对话的启动参数，不改 ${agentLabel} 的配置。${live ? "开聊后换会重开并接回这段对话。" : ""}`}
          </p>
        </div>
      )}
    </div>
  );
}
