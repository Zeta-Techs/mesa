import {
  appUpdateProgressLabel,
  appUpdateProgressPct,
  type AppUpdateInstallPhase,
} from "../app-update";

/**
 * 更新下载进度条：设置页卡片与帮助菜单「检查更新」弹窗共用。
 * 还不知道总大小（下载刚起、或更新源不给长度）时画来回滑动的不定进度，知道后才按真实字节画宽度——
 * 不拿固定宽度占位，否则总大小一到就从占位宽度跌回 0，看着像重新下载。
 */
export default function UpdateProgressBar({
  downloaded,
  total,
  className = "",
}: {
  downloaded: number;
  total: number | null;
  className?: string;
}) {
  const pct = appUpdateProgressPct(downloaded, total);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={`h-1 overflow-hidden rounded-full bg-inset ${className}`}
    >
      {pct === null ? (
        <div className="ccode-progress-indeterminate h-full w-1/3 bg-ok-text" />
      ) : (
        <div className="h-full bg-ok-text transition-[width]" style={{ width: `${pct}%` }} />
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
      <div className="mb-1 flex justify-between gap-3 text-micro text-l3">
        <span className="min-w-0 truncate tabular-nums">
          {appUpdateProgressLabel(phase, downloaded, total)}
        </span>
        {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </div>
      {phase === "downloading" ? (
        <UpdateProgressBar downloaded={downloaded} total={total} />
      ) : (
        <UpdateProgressBar downloaded={1} total={1} />
      )}
    </div>
  );
}
