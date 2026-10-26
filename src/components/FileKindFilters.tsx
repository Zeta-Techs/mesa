import { Clock } from "lucide-react";
import { OFFICE_FILTERS } from "../work-mode";
import type { OfficeDocKind } from "../work-mode";
import type { ProjectFileFilter } from "../project-files";

type KindFilter = (typeof OFFICE_FILTERS)[number]["id"];

/** 类型筛选写字不画图标（2026-10-26 用户拍板）：文件行换成线条类型图标后，
 *  「文档」钮的页面图标和 PDF 行同形，PDF 钮又是字，一排里图标和字混着认不准 */
const LABELS: Record<KindFilter, string> = {
  all: "全部",
  doc: "文档",
  sheet: "表格",
  slide: "幻灯",
  pdf: "PDF",
  image: "图片",
  other: "其他",
};

export default function FileKindFilters({
  filter,
  counts,
  onChange,
  recent,
  onToggleRecent,
}: {
  filter: ProjectFileFilter;
  counts: Record<OfficeDocKind | "all", number>;
  onChange: (id: ProjectFileFilter) => void;
  /** 「最近修改」视图是否激活（与类型筛选互斥的单选语义） */
  recent?: boolean;
  onToggleRecent?: () => void;
}) {
  const capsule = (selected: boolean) =>
    `flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${
      selected ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
    }`;
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
      role="radiogroup"
      aria-label="文件类型"
    >
      {OFFICE_FILTERS.filter(
        (item) =>
          item.id === "all" || item.id === filter || counts[item.id] > 0,
      ).map((item) => {
        const count = item.id === "all" ? 0 : counts[item.id];
        const selected = filter === item.id;
        const label = LABELS[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={count > 0 ? `${label} ${count}` : label}
            className={capsule(selected)}
            onClick={() => onChange(item.id)}
          >
            {label}
            {count > 0 && <span className="text-micro text-l4">{count}</span>}
          </button>
        );
      })}
      {onToggleRecent && (
        <button
          type="button"
          role="radio"
          aria-checked={!!recent}
          title="按最近修改排列"
          className={capsule(!!recent)}
          onClick={onToggleRecent}
        >
          <Clock size={13} strokeWidth={1.8} />
          最近
        </button>
      )}
    </div>
  );
}
