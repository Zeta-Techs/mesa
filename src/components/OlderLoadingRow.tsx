/**
 * 回放顶部「更早的内容」占位行：往上翻自动加载（auto-load-older.ts）后不再放按钮——
 * 按钮文字在「加载更早对话 / 加载中…」间来回换、禁用态变淡，滑动时一直闪（2026-10-21 用户）。
 * 行高固定，加载与否都不挪动下面的内容；只在加载中淡淡显示一行字。
 */
export default function OlderLoadingRow({
  loading,
  className = "",
}: {
  loading: boolean;
  className?: string;
}) {
  return (
    <div
      aria-live="polite"
      className={`flex h-6 items-center justify-center text-micro text-l3 ${className}`}
    >
      {loading ? "正在加载更早的内容…" : null}
    </div>
  );
}
