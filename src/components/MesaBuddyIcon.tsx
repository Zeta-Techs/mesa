import { normalizeBuddyStyle, type BuddyStyle } from "../buddy-sprite";
import { useAppStore } from "../store";

/**
 * 项目助手入口线条小图标（顶栏按钮用）：和 Lucide 同笔触（24 格、圆头、currentColor），
 * 去掉早期卡通腮红笑脸，随设置里的助手形象（桌角黑猫 / Monolith）同步切换。
 */
export default function MesaBuddyIcon({
  size = 14,
  strokeWidth = 1.8,
  className = "",
  buddyStyle,
  ...rest
}: {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  buddyStyle?: BuddyStyle;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  const storeStyle = useAppStore((s) => s.settings?.buddyStyle);
  const style = normalizeBuddyStyle(buddyStyle ?? storeStyle);

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
      {style === "monolith" ? (
        <>
          <rect x="3" y="4.5" width="18" height="15" rx="4.5" />
          <rect x="7.2" y="11" width="3.4" height="1.9" rx="0.8" fill="var(--color-mesa-amber)" stroke="none" />
          <rect x="13.4" y="11" width="3.4" height="1.9" rx="0.8" fill="var(--color-mesa-amber)" stroke="none" />
        </>
      ) : (
        <>
          <path d="M5 5.5 L8.2 8.2 H15.8 L19 5.5 V14 C19 17.6 16 20 12 20 C8 20 5 17.6 5 14 V5.5 Z" />
          <rect x="8.2" y="12.2" width="2.4" height="1.8" rx="0.6" fill="var(--color-mesa-amber)" stroke="none" />
          <rect x="13.4" y="12.2" width="2.4" height="1.8" rx="0.6" fill="var(--color-mesa-amber)" stroke="none" />
        </>
      )}
    </svg>
  );
}
