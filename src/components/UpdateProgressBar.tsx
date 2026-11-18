import { LoaderCircle } from "lucide-react";
import {
  appUpdateActionLabel,
  appUpdateProgressLabel,
  appUpdateProgressPct,
  type AppUpdateInstallPhase,
} from "../app-update";

/**
 * 更新下载进度条：设置页卡片与帮助菜单「检查更新」弹窗共用。颜色跟主按钮同一个 cta（2026-11-18 用户「更美观一点」，原为绿色）。
 * 还不知道总大小（下载刚起、或更新源不给长度）时画一段两头渐隐的光从左扫到右，知道后才按真实字节画宽度——
 * 不拿固定宽度占位，否则总大小一到就从占位宽度跌回 0，看着像重新下载。已知进度时填充部分上有一道高光慢慢掠过；
 * done = 下完了在安装 / 重启：满格轻轻呼吸。动画都在 App.css「更新进度条」，减弱动态效果时停下。
 */
export default function UpdateProgressBar({
  downloaded,
  total,
  done = false,
  className = "",
}: {
  downloaded: number;
  total: number | null;
  done?: boolean;
  className?: string;
}) {
  const pct = done ? 100 : appUpdateProgressPct(downloaded, total);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={`relative h-1.5 overflow-hidden rounded-full bg-hover ${className}`}
    >
      {pct === null ? (
        <div className="ccode-progress-indeterminate h-full rounded-full" />
      ) : (
        <div
          className={`relative h-full overflow-hidden rounded-full bg-cta transition-[width] duration-200 ease-(--ccode-motion-ease) ${
            done ? "ccode-progress-breathe" : ""
          }`}
          style={{ width: `${pct}%` }}
        >
          {!done && pct < 100 && <span className="ccode-progress-sheen" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

/**
 * 下载并安装的整块进度：上方一行写在哪一段（下载时左边已下 / 总大小、右边百分比），下面是进度条。
 * 下完以后条保持满格、字换成「正在安装」「正在重启」，不回落成不定进度，免得看着像又重新开始。
 */
export function UpdateInstallProgress({
  phase,
  downloaded,
  total,
  className = "",
}: {
  phase: AppUpdateInstallPhase;
  downloaded: number;
  total: number | null;
  className?: string;
}) {
  const pct = phase === "downloading" ? appUpdateProgressPct(downloaded, total) : null;
  return (
    <div className={className}>
      <div className="mb-1.5 flex justify-between gap-3 text-micro">
        <span className="min-w-0 truncate tabular-nums text-l2">
          {appUpdateProgressLabel(phase, downloaded, total)}
        </span>
        {pct !== null && <span className="shrink-0 tabular-nums text-l3">{pct}%</span>}
      </div>
      <UpdateProgressBar downloaded={downloaded} total={total} done={phase !== "downloading"} />
    </div>
  );
}

/** 「下载并安装」按钮里的字：进行中前面加一个转圈，按钮本身不变灰（变灰的主按钮看着像点不了出错了） */
export function UpdateActionContent({ phase }: { phase: AppUpdateInstallPhase | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {phase && (
        <LoaderCircle size={13} strokeWidth={2} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      )}
      {appUpdateActionLabel(phase)}
    </span>
  );
}

/** 安装进行中时主按钮的附加类：保持实色、不显示禁用光标（disabled 照旧防重复点击） */
export const UPDATE_ACTION_BUSY_CLASS = "disabled:opacity-100 disabled:cursor-default";
