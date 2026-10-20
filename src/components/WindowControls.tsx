import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Windows 自绘窗口按钮：窗口去掉原生标题栏后，最小化/最大化/关闭放在标题栏最右。
 *  仅 Windows 渲染（调用方判平台）；macOS 用系统红绿灯，Linux 仍是原生标题栏。 */
export default function WindowControls({ className = "" }: { className?: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;
    const sync = () => {
      void win
        .isMaximized()
        .then((v) => alive && setMaximized(v))
        .catch(() => {});
    };
    sync();
    void win
      .onResized(sync)
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const base =
    "flex h-full w-[46px] shrink-0 items-center justify-center text-l2 hover:bg-hover hover:text-l1";
  const win = () => getCurrentWindow();

  return (
    <div className={`flex shrink-0 self-stretch ${className}`}>
      <button
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win().minimize()}
        className={base}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win().toggleMaximize()}
        className={base}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win().close()}
        className="flex h-full w-[46px] shrink-0 items-center justify-center text-l2 hover:bg-[#c42b1c] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M0 0l10 10M10 0L0 10"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
