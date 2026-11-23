import { useSyncExternalStore } from "react";
import { CheckCheck, X } from "lucide-react";
import {
  inboxBulkReadLabel,
  inboxUrgencyOf,
  type InboxGroup,
} from "../inbox";
import type { InboxItem } from "../store";

/**
 * 收件箱悬浮列表：顶栏「待处理」胶囊（macOS / Windows）与页内条（Linux）共用。
 * 视觉对齐顶栏帮助菜单（rounded-lg + ccode-float-surface + ccode-menu-surface）；
 * 支持整行点击直达、两行可读不强截断、紧迫/通知视觉分层、悬停显露 Lucide 忽略钮与 ↑/↓/Home/End 键盘走焦。
 */
export default function InboxPopover({
  groups,
  totalCount,
  bulkItems,
  align = "right",
  onRunAction,
  onDismiss,
  onDismissBulk,
  devPreviewActive = false,
  onExitDevPreview,
}: {
  groups: readonly InboxGroup<InboxItem>[];
  totalCount: number;
  bulkItems: readonly InboxItem[];
  /** 顶栏靠右对齐，Linux 页内条靠左对齐 */
  align?: "right" | "left";
  onRunAction: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
  onDismissBulk: (items: readonly InboxItem[]) => void;
  devPreviewActive?: boolean;
  onExitDevPreview?: () => void;
}) {
  const bulkLabel = inboxBulkReadLabel(bulkItems.length, totalCount);
  // 计数只在不重复时出（2026-10-26 规则）：只有一类时「共 N 条」与分类小标题同数，
  // 一类只一条时小标题的数字与那一行同义——都不挂；表头只在多组 / 有可已读项 / 开发预览时出现
  const showHeader = groups.length > 1 || bulkItems.length > 0 || devPreviewActive;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const rows = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[data-inbox-row]"),
    );
    if (!rows.length) return;
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? rows[0]
        : e.key === "End"
          ? rows[rows.length - 1]
          : e.key === "ArrowDown"
            ? rows[(idx + 1 + rows.length) % rows.length]
            : rows[(idx - 1 + rows.length) % rows.length];
    next.focus();
  }

  return (
    <div
      role="region"
      aria-label="待处理列表"
      onKeyDown={onKeyDown}
      className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-40 mt-1.5 max-h-[min(22rem,70vh)] w-[336px] max-w-[85vw] overflow-y-auto overscroll-contain rounded-lg border border-field ccode-float-surface ccode-menu-surface`}
    >
      {showHeader && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-hairline/80 bg-raised/90 px-2.5 py-1 backdrop-blur-md">
          <span className="flex items-center gap-1.5 text-micro tabular-nums text-l3">
            {groups.length > 1 && <span>共 {totalCount} 条</span>}
            {devPreviewActive && (
              <span className="rounded-full bg-cta-pill px-1.5 py-px text-micro text-cta-pill-text">
                开发预览
              </span>
            )}
          </span>
          <div className="flex items-center gap-1">
            {devPreviewActive && onExitDevPreview && (
              <button
                type="button"
                onClick={onExitDevPreview}
                className="rounded px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
              >
                退出预览
              </button>
            )}
            {bulkItems.length > 0 && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
                title="一键收起信息类通报（文献 / 可合并 / 待核验 / 手机 / 技能 / 项目助手）；冲突、待确认这类要你拍板的不受影响，被收起的条目状态一变还会回来"
                aria-label={`${bulkLabel}（仅信息类）`}
                onClick={() => onDismissBulk(bulkItems)}
              >
                <CheckCheck size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>{bulkLabel}</span>
              </button>
            )}
          </div>
        </div>
      )}

      <ul className="p-1">
        {groups.map((group, groupIndex) => {
          const groupUrgency = inboxUrgencyOf(group.items[0]?.key ?? "");
          const isBlockingGroup = groupUrgency === "blocking";
          return (
            <li
              key={group.category}
              className={
                groupIndex > 0 ? "mt-1 border-t border-hairline/60 pt-1" : ""
              }
            >
              <div className="flex items-center justify-between px-2 py-0.5 text-micro">
                <span
                  className={
                    isBlockingGroup
                      ? "font-medium text-l2"
                      : "text-l3"
                  }
                >
                  {group.label}
                </span>
                {group.items.length > 1 && (
                  <span className="tabular-nums text-l4">
                    {group.items.length}
                  </span>
                )}
              </div>
              <div className="space-y-px">
                {group.items.map((item) => {
                  const urgency = inboxUrgencyOf(item.key);
                  const isBlocking = urgency === "blocking";
                  return (
                    <div
                      key={item.key}
                      className="group/row flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-[5px] size-1.5 shrink-0 rounded-full ${item.dot}`}
                      />
                      <button
                        type="button"
                        data-inbox-row
                        title={item.text}
                        onClick={() => onRunAction(item)}
                        className={`min-w-0 flex-1 text-left text-xs leading-snug line-clamp-2 break-words focus:outline-none ${
                          isBlocking
                            ? "font-medium text-l1"
                            : urgency === "decide"
                              ? "text-l1"
                              : "text-l2"
                        }`}
                      >
                        {item.text}
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          title="忽略（状态变化后会重新出现）"
                          aria-label={`忽略：${item.text}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismiss(item);
                          }}
                          className="hidden size-5 items-center justify-center rounded text-l4 hover:bg-inset hover:text-l1 focus:flex group-hover/row:flex group-focus-within/row:flex"
                        >
                          <X size={12} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRunAction(item);
                          }}
                          className={`inline-flex h-[22px] shrink-0 items-center justify-center rounded px-1.5 text-micro transition-colors ${
                            isBlocking
                              ? "ccode-inbox-action-blocking font-medium"
                              : "border border-field bg-strip text-l2 hover:bg-inset hover:text-l1"
                          }`}
                        >
                          {item.actionLabel}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 仅开发版（热更新窗口）用于预览收件箱三级配色与下拉样式，打包后的正式版永不触发 ──

const DEV_INBOX_KEY_PREFIX = "__dev_preview__:";
const EMPTY_PREVIEW: readonly InboxItem[] = [];

function buildDevInboxMockItems(): InboxItem[] {
  return [
    {
      key: `confirm:${DEV_INBOX_KEY_PREFIX}1`,
      dot: "bg-warn-text",
      text: "催化剂综述 · 文献精读任务等待你批准运行脚本（lit_records.py validate）",
      actionLabel: "去处理",
      action: { type: "profiles" },
    },
    {
      key: `ready:${DEV_INBOX_KEY_PREFIX}2`,
      dot: "bg-ok-text",
      text: "催化剂综述 · 综述大纲与章节结构已做完，可评审保存",
      actionLabel: "去评审",
      action: { type: "profiles" },
    },
    {
      key: `lit:${DEV_INBOX_KEY_PREFIX}3`,
      dot: "bg-ok-text",
      text: "电催化文献雷达有 4 篇高相关新命中（Nature Catal. / JACS 等）",
      actionLabel: "去查看",
      action: { type: "profiles" },
    },
    {
      key: `asst:${DEV_INBOX_KEY_PREFIX}4`,
      dot: "bg-ok-text",
      text: "项目助手派出的「补齐 Supporting Information 对照表」已完成",
      actionLabel: "看详情",
      action: { type: "profiles" },
    },
  ];
}

let devInboxItems: readonly InboxItem[] = EMPTY_PREVIEW;
const devInboxListeners = new Set<() => void>();

function emitDevInbox() {
  for (const fn of devInboxListeners) fn();
}

function subscribeDevInbox(fn: () => void) {
  devInboxListeners.add(fn);
  return () => {
    devInboxListeners.delete(fn);
  };
}

function getDevInboxSnapshot(): readonly InboxItem[] {
  return import.meta.env.DEV ? devInboxItems : EMPTY_PREVIEW;
}

export function useDevInboxPreview(): readonly InboxItem[] {
  return useSyncExternalStore(
    subscribeDevInbox,
    getDevInboxSnapshot,
    () => EMPTY_PREVIEW,
  );
}

export function isDevInboxPreviewItem(item: { key: string }): boolean {
  return Boolean(import.meta.env.DEV && item.key.includes(DEV_INBOX_KEY_PREFIX));
}

export function toggleDevInboxPreview(on?: boolean): boolean {
  if (!import.meta.env.DEV) return false;
  const next = on ?? devInboxItems.length === 0;
  devInboxItems = next ? buildDevInboxMockItems() : EMPTY_PREVIEW;
  emitDevInbox();
  return next;
}

export function dismissDevInboxPreviewItems(keys: readonly string[]) {
  if (!import.meta.env.DEV || devInboxItems.length === 0) return;
  const drop = new Set(keys);
  devInboxItems = devInboxItems.filter((it) => !drop.has(it.key));
  emitDevInbox();
}
