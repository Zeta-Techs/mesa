/**
 * 「小桌」的线条小图标（项目助手入口按钮用，2026-11-04 用户：救生圈换掉 →「只留脸」）：和 Lucide 图标同一种笔触（24 格、圆头、currentColor），
 * 只有桌裙那张脸（圆角框 + 两点眼 + 一道笑），按钮里不挤。可当 LucideIcon 传（size / strokeWidth / className）
 */
export default function MesaBuddyIcon({
  size = 14,
  strokeWidth = 1.8,
  className = "",
  ...rest
}: {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {/* 2026-11-05 用户：「图标还是有点简陋」——改成会说话的笑脸气泡（右上缺口里一颗琥珀星，示意 AI），两颊琥珀；
          线条跟文字色走，琥珀用品牌色 --color-mesa-amber，深浅主题都成立。14px 下实测能认出是张脸 */}
      <path d="M15 5.2H8.4a4.8 4.8 0 0 0-4.8 4.8v3.4a4.8 4.8 0 0 0 4.8 4.8h.9v2.6l3.4-2.6h2.9a4.8 4.8 0 0 0 4.8-4.8v-1.6" />
      <path
        d="M19.4 2.2l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z"
        fill="var(--color-mesa-amber)"
        stroke="var(--color-mesa-amber)"
        strokeWidth={1}
      />
      <ellipse cx="9.3" cy="11.3" rx="1.05" ry="1.35" fill="currentColor" stroke="none" />
      <ellipse cx="14.5" cy="11.3" rx="1.05" ry="1.35" fill="currentColor" stroke="none" />
      <circle cx="7.2" cy="13.9" r="1" fill="var(--color-mesa-amber)" stroke="none" />
      <circle cx="16.6" cy="13.9" r="1" fill="var(--color-mesa-amber)" stroke="none" />
      <path d="M10.5 14.3c.8.7 2 .7 2.8 0" />
    </svg>
  );
}
