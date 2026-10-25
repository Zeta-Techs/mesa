import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import { InlineNotice, ghostActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import {
  DECISION_KIND_LABEL,
  HANDOFF_REASON_LABEL,
  handoffTotals,
  isAutoHandoff,
  type ChatHandoffStat,
  type HandoffReason,
} from "../chat-handoff-log";

/** 细分的说法：确认卡按种类，其余几个入口各自一句；认不得的照原样 */
const DETAIL_LABEL: Record<string, string> = {
  ...DECISION_KIND_LABEL,
  slash: "斜杠命令",
  menu: "模型菜单",
  "tab-bar": "顶部切换钮",
  hotkey: "快捷键",
  beta: "测试版说明里",
  peek: "露出终端",
  open: "打开终端",
};

/** 设置「诊断」：聊天层转到终端的次数，按次数排——排在前面的就是聊天层下一步最该补的。
 *  外形与后台任务卡一致（卡头标题 + 一句说明，不画分隔线） */
export default function ChatHandoffStatsPanel() {
  const [days, setDays] = useState<30 | 0>(30);
  const [stats, setStats] = useState<ChatHandoffStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (d: number) =>
    invoke<ChatHandoffStat[]>("chat_handoff_summary", { days: d || null })
      .then((rows) => {
        setStats(rows);
        setError(null);
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load(days);
  }, [days]);

  const clear = async () => {
    if (!(await confirmDialog("清空聊天层转到终端的全部记录？只是计数，清空后从零开始记。", { danger: true, confirmText: "清空" }))) return;
    try {
      await invoke("chat_handoff_clear");
      await load(days);
    } catch (e) {
      setError(String(e));
    }
  };

  const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
  const { total, auto } = handoffTotals(stats ?? []);
  const rangeBtn = (d: 30 | 0, text: string) => (
    <button
      type="button"
      aria-pressed={days === d}
      onClick={() => setDays(d)}
      className={`${ghostActionClass} ${days === d ? "bg-seg-sel text-l1" : ""}`}
    >
      {text}
    </button>
  );

  return (
    <div className="mt-3 rounded-lg ccode-well p-3">
      <div className="mb-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-l2">聊天层转到终端</div>
          <p className="mt-0.5 text-micro leading-4 text-l4">
            聊天里接不住、要露出或切到终端的次数，按次数排。只记哪家、什么原因，不记屏上文字和对话内容；诊断包里附同一份计数
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {rangeBtn(30, "近 30 天")}
          {rangeBtn(0, "全部")}
          <button
            type="button"
            disabled={!stats?.length}
            onClick={() => void clear()}
            className={ghostActionClass}
          >
            清空
          </button>
        </div>
      </div>
      {error && <InlineNotice tone="err">{error}</InlineNotice>}
      {stats && !stats.length && !error && (
        <p className="px-1 text-xs text-l4">还没有记录：聊天层这段时间都接住了</p>
      )}
      {stats && stats.length > 0 && (
        <>
          <p className="mb-1 px-1 text-micro text-l4">
            共 {total} 次，其中 Mesa 自动露出 {auto} 次、你自己点开 {total - auto} 次
          </p>
          {stats.map((s) => {
            const reason =
              HANDOFF_REASON_LABEL[s.reason as HandoffReason] ?? s.reason;
            const detail = s.detail ? DETAIL_LABEL[s.detail] ?? s.detail : "";
            return (
              <div
                key={`${s.agent}|${s.reason}|${s.detail}`}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-hover"
                title={s.versions.length ? `出现过的版本：${s.versions.join("、")}` : undefined}
              >
                <span className="w-24 shrink-0 truncate text-l2">{agentLabel(s.agent)}</span>
                <span className="min-w-0 flex-1 truncate text-l3">
                  {reason}
                  {detail && <span className="text-l4"> · {detail}</span>}
                  {!isAutoHandoff(s.reason) && <span className="text-l4">（手动）</span>}
                </span>
                {s.versions[0] && (
                  <span className="shrink-0 tabular-nums text-l4">{s.versions[0]}</span>
                )}
                <span className="shrink-0 tabular-nums text-l4">{s.lastDay.slice(5)}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-l1">{s.count} 次</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
