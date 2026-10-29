import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InlineNotice, MenuSelect, Toggle, paneOutlineButtonClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { toast } from "../toast";
import { absTime, relTime } from "../rel-time";
import {
  INTERNAL_RETENTION_CHOICES,
  formatStorageBytes,
  internalCleanupConfirmText,
  type InternalSessionsStats,
} from "../internal-sessions";

/**
 * 设置 →「数据与存储」→ Mesa 内部对话（2026-10-17）：起标题、提交信息、摘要、雷达解读这类
 * 后台 AI 调用在各家 CLI 目录里留下的对话。只动 Mesa 自己产生的（临时目录 / 雷达隔离目录里、
 * 没被保留的），用户项目里的对话一条不碰；用量历史不受影响。
 */
export default function InternalSessionsCard({
  autoClean,
  retentionDays,
  onPatch,
}: {
  autoClean: boolean;
  retentionDays: number;
  onPatch: (p: { internalAutoClean?: boolean; internalRetentionDays?: number }) => Promise<void>;
}) {
  const [stats, setStats] = useState<InternalSessionsStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  async function load() {
    setError(null);
    try {
      setStats(await invoke<InternalSessionsStats>("internal_sessions_stats"));
    } catch (e) {
      setError(`统计失败：${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
    // 保留天数一变，「将清理」数字跟着重算
  }, [retentionDays]);

  async function cleanNow() {
    if (!stats || stats.eligible === 0 || cleaning) return;
    const ok = await confirmDialog(internalCleanupConfirmText(stats), {
      confirmText: "清理",
      danger: true,
    });
    if (!ok) return;
    setCleaning(true);
    try {
      const r = await invoke<{ deleted: number; bytes: number; failed: string[] }>(
        "cleanup_internal_sessions",
      );
      toast(
        r.failed.length
          ? `已清理 ${r.deleted} 条（${formatStorageBytes(r.bytes)}）。另有 ${r.failed.length} 条没删掉，文件还在原处。`
          : `已清理 ${r.deleted} 条内部对话，释放 ${formatStorageBytes(r.bytes)}。`,
        r.failed.length ? "warning" : "success",
      );
      await load();
    } catch (e) {
      setError(`清理失败：${String(e)}`);
    } finally {
      setCleaning(false);
    }
  }

  // 2026-10-17 用户反馈「看着有点复杂」后收拢：原先一段长说明 + 一行四件事（统计 / 保留下拉 /
  // 超期状态 / 清理钮）+ 底部再复述一遍自动清理规则。现在同「本机占用」卡口径：卡头一句话带出
  // 条数与大小、清理钮进卡头；下面只一行「自动清理」= 规则一句 + 保留天数 + 开关。
  // 最早一条的时间与超期细节进悬浮，不占版面
  const canClean = !!stats && stats.eligible > 0 && !cleaning;
  return (
    // 设置页 2026-10-29 起不套卡：接在「本机占用」那组下面（上边线由那组的底线给），只画底线
    <div className="border-b border-hairline py-3.5">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base text-l1">Mesa 内部对话</div>
          <p
            className="mt-0.5 text-sm leading-relaxed text-l3"
            title="起标题、提交信息、摘要、雷达解读这类后台调用在各家 CLI 目录里留下的对话。只清 Mesa 自己产生的，你项目里的对话、你保留过的对话一条不碰；花费记录永久保留在用量页"
          >
            后台起名、摘要等调用留下的对话
            {stats === null ? "，统计中…" : `，共 ${stats.total} 条 · ${formatStorageBytes(stats.totalBytes)}`}
            {stats?.oldest ? (
              <span title={absTime(stats.oldest)}>（最早 {relTime(stats.oldest)}）</span>
            ) : null}
            。项目里的对话不受影响
          </p>
        </div>
        <button
          type="button"
          className={`${paneOutlineButtonClass} shrink-0`}
          disabled={!canClean}
          title={
            stats && stats.eligible === 0
              ? `没有超过 ${retentionDays} 天的`
              : "删除超过保留期的内部对话（直接删除，不进回收站）"
          }
          onClick={() => void cleanNow()}
        >
          {cleaning
            ? "清理中…"
            : stats && stats.eligible > 0
              ? `清理 ${stats.eligible} 条（${formatStorageBytes(stats.eligibleBytes)}）`
              : "立即清理"}
        </button>
      </div>
      {error && <InlineNotice className="mb-2">{error}</InlineNotice>}
      <div className="mt-3 flex min-h-10 items-center justify-between gap-3 border-t border-hairline pt-3">
        <div className="min-w-0">
          <div className="text-base text-l1">自动清理</div>
          <p className="mt-0.5 truncate text-sm leading-relaxed text-l3">
            {autoClean
              ? `每天至多一次，删掉超过保留期的${stats?.lastCleanAt ? `；上次 ${relTime(stats.lastCleanAt)}` : ""}`
              : "已关：内部对话一直留着；右上角手动清理同样只删超过保留期的"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-2 text-xs">
            <span className="text-l4">保留</span>
            <span className="w-24">
              <MenuSelect
                aria-label="内部对话保留天数"
                value={String(retentionDays)}
                options={INTERNAL_RETENTION_CHOICES.map((d) => ({
                  value: String(d),
                  label: `${d} 天`,
                }))}
                onChange={(v) => void onPatch({ internalRetentionDays: Number(v) })}
              />
            </span>
          </span>
          <Toggle
            label="自动清理内部对话"
            checked={autoClean}
            onChange={(v) => void onPatch({ internalAutoClean: v })}
          />
        </div>
      </div>
    </div>
  );
}
