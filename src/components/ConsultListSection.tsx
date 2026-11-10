import { Users } from "lucide-react";
import VendorIcon from "./VendorIcon";
import { absTime, relTime } from "../rel-time";
import type { VendorId } from "../vendor-icon";
import type { ConsultListItem } from "../consult";

/**
 * 对话页列表顶上的「研讨」一组（2026-11-11）：研讨不是 CLI 会话，不混进会话行（键、↑↓、批量勾选都只认会话），
 * 单独成组放在最上面；行的 Agent 胶囊换成成员所选模型的图标叠。
 */
export default function ConsultListSection({
  items,
  activeId,
  onSelect,
  projectLabel,
}: {
  items: ConsultListItem[];
  activeId: string | null;
  onSelect: (item: ConsultListItem) => void;
  /** 范围已限定单项目时传 null（不重复写项目名） */
  projectLabel: ((path: string) => string | null) | null;
}) {
  if (!items.length) return null;
  return (
    <div className="pb-1.5 pt-2">
      <div className="flex items-center gap-1.5 px-4 pb-1 text-xs text-l4">
        <Users size={12} strokeWidth={1.8} aria-hidden="true" />
        <span>研讨</span>
        <span className="text-micro">{items.length}</span>
      </div>
      {items.map((c) => {
        const label = projectLabel?.(c.projectRoot) ?? null;
        return (
          <div
            key={`${c.projectRoot}#${c.id}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(c)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(c);
            }}
            className={`group mx-1.5 cursor-pointer rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover ${activeId === c.id ? "bg-rail-sel" : ""}`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {c.busy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ok-text" aria-label="正在答" />}
              <span className="min-w-0 flex-1 truncate text-l1">{c.title}</span>
              <span className="shrink-0 font-mono text-micro text-l4" title={absTime(c.updatedAt)}>
                {relTime(c.updatedAt)}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro text-l4">
              <span className="flex shrink-0 -space-x-1">
                {c.members.map((m) => (
                  <span
                    key={m.id}
                    title={`${m.name} · ${m.model || "默认模型"}`}
                    className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-inset ring-2 ring-rail2"
                  >
                    <VendorIcon vendor={(m.family as VendorId | null) ?? null} name={m.name} className="scale-[0.8]" />
                  </span>
                ))}
              </span>
              <span className="shrink-0">研讨 · {c.members.length} 家</span>
              {label && (
                <span className="min-w-0 truncate text-l3" title={c.projectRoot}>
                  {label}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div className="mx-4 mt-1.5 border-t border-hairline" />
    </div>
  );
}
