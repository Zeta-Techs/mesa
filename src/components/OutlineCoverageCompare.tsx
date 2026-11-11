import { useState } from "react";
import type { CoverageRowCheck } from "../outline-check";

/** 核验清单里的「覆盖检查对照」：大纲「覆盖检查」AI 写的篇数与 Mesa 按笔记状态数的并排（综述回路三期）。
 *  2026-11-11 用户：整张表压在大纲上面挡着看稿——挪进核验清单，默认一行；展开先只列对不上的节，要看全部再点。
 *  点节名跳到大纲里那一节。篇数以 Mesa 数的为准；够 / 薄仍是 AI 判断、人拍板 */
export default function OutlineCoverageCompare({
  rows,
  onJump,
  compact = false,
}: {
  rows: readonly CoverageRowCheck[];
  /** 放在窄侧栏里：只留节和两列篇数，年份与 AI 的判断进悬停 */
  compact?: boolean;
  /** 跳到大纲里这一节（传节名，如「5.3 器件出口…」） */
  onJump?: (label: string) => void;
}) {
  const off = rows.filter((r) => r.mismatch);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all || off.length === 0 ? rows : off;
  const cell = (ai: number | null, mesa: number | undefined) => {
    const differ = mesa !== undefined && ai !== null && ai !== mesa;
    return (
      <td className={`px-1.5 py-0.5 text-right tabular-nums ${differ ? "text-warn-text" : "text-l2"}`}>
        {ai ?? "?"}
        <span className="text-l4"> / </span>
        {mesa ?? "—"}
      </td>
    );
  };
  return (
    <section aria-label="覆盖检查对照" className="mb-1.5 text-micro">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="大纲「覆盖检查」表里的篇数是 AI 写的；Mesa 按每节拟引用和笔记状态另数一遍：全文精读写完的算可写正文，仅摘要、只速读的算仅线索。篇数以 Mesa 数的为准，够不够由你定"
        className={`hover:text-l1 ${off.length > 0 ? "text-warn-text" : "text-l3"}`}
      >
        覆盖检查对照（{off.length > 0 ? `${off.length} 节篇数对不上` : "篇数都对得上"}）{open ? " 收起" : " 展开"}
      </button>
      {open && (
        <>
          <table className="mt-0.5 w-full border-collapse">
            <thead>
              <tr className="text-l4">
                <th className="px-1.5 py-0.5 text-left font-normal">节</th>
                <th className="px-1.5 py-0.5 text-right font-normal">{compact ? "可写" : "可写正文 AI / Mesa"}</th>
                <th className="px-1.5 py-0.5 text-right font-normal">{compact ? "线索" : "仅线索 AI / Mesa"}</th>
                {!compact && <th className="px-1.5 py-0.5 text-right font-normal">最新一篇</th>}
                {!compact && <th className="px-1.5 py-0.5 text-left font-normal">AI 的判断</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.label}
                  className={r.mismatch && all ? "bg-strip" : undefined}
                  title={compact ? `AI 写 / Mesa 数。最新一篇 ${r.ai.latest || "?"} / ${r.mesa?.latest ?? "—"}；AI 的判断：${r.ai.verdict || "—"}` : undefined}
                >
                  <td className="max-w-[16rem] px-1.5 py-0.5">
                    {onJump ? (
                      <button
                        type="button"
                        onClick={() => onJump(r.label)}
                        title={r.mesa ? `跳到大纲里的「${r.label}」` : `${r.label}（大纲里找不到这一节的拟引用，Mesa 没法数）`}
                        className="block max-w-full truncate text-left text-l2 hover:text-l1 hover:underline"
                      >
                        {r.label}
                      </button>
                    ) : (
                      <span className="block truncate text-l2" title={r.label}>
                        {r.label}
                      </span>
                    )}
                  </td>
                  {cell(r.ai.writable, r.mesa?.writable.length)}
                  {cell(r.ai.hint, r.mesa?.hint.length)}
                  {!compact && (
                    <td className="px-1.5 py-0.5 text-right tabular-nums text-l3">
                      {r.ai.latest || "?"}
                      <span className="text-l4"> / </span>
                      {r.mesa?.latest ?? "—"}
                    </td>
                  )}
                  {!compact && (
                    <td className="max-w-[12rem] truncate px-1.5 py-0.5 text-l3" title={r.ai.verdict}>
                      {r.ai.verdict}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {off.length > 0 && off.length < rows.length && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-0.5 text-l4 hover:text-l1">
              {all ? "只看对不上的" : `看全部 ${rows.length} 节`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
