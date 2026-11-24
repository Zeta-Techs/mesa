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
 * 设置 →「数据与存储」→ Mesa 内部对话：
 * 统一采用设置页分组卡片（SubHeading + .ccode-well rounded-xl + 左标题说明 / 右控件）。
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

  const canClean = !!stats && stats.eligible > 0 && !cleaning;
  return (
    <div className="mt-6">
      <div className="mb-2 px-0.5">
        <h3 className="text-xs font-semibold tracking-wide text-l2">Mesa 内部对话</h3>
      </div>
      <div className="ccode-well divide-y divide-hairline overflow-hidden rounded-xl border border-hairline px-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">已留存记录</div>
            <p
              className="mt-0.5 text-xs leading-relaxed text-l3"
              title="起标题、提交信息、摘要、雷达解读这类后台调用在各家 Agent 的会话目录里留下的对话。只清 Mesa 自己产生的，你项目里的对话、你保留过的对话一条不碰；花费记录永久保留在用量页"
            >
              {stats === null ? "统计中…" : `共 ${stats.total} 条 · ${formatStorageBytes(stats.totalBytes)}`}
              {stats?.oldest ? (
                <span title={absTime(stats.oldest)}>（最早 {relTime(stats.oldest)}）</span>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
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
          {error && (
            <div className="basis-full">
              <InlineNotice>{error}</InlineNotice>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">自动清理</div>
            <p className="mt-0.5 truncate text-xs leading-relaxed text-l3">
              {autoClean
                ? `超过保留期自动删除${stats?.lastCleanAt ? `；上次 ${relTime(stats.lastCleanAt)}` : ""}`
                : "已关"}
            </p>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-3">
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
    </div>
  );
}
