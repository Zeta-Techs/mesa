import { useState } from "react";
import type { CoverageRowCheck } from "../outline-check";

/** 评审页大纲预览上方：「覆盖检查」AI 写的与 Mesa 按笔记状态数的并排，对不上的标出来（综述回路三期）。
 *  篇数以 Mesa 数的为准；够 / 薄仍是 AI 判断、人拍板 */
export default function OutlineCoverageCompare({ rows }: { rows: readonly CoverageRowCheck[] }) {
  const off = rows.filter((r) => r.mismatch).length;
  const [open, setOpen] = useState(off > 0);
  if (rows.length === 0) return null;
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
    <section aria-label="覆盖检查对照" className="shrink-0 border-b border-hairline px-3 py-1.5 text-micro">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="大纲里「覆盖检查」表的篇数是 AI 写的；Mesa 按每节拟引用里的键和笔记状态另数一遍（全文精读写完的算可写正文，仅摘要、只速读的算仅线索）。篇数以 Mesa 数的为准，够不够由你定"
        className={`rounded-sm px-1 hover:bg-hover ${off > 0 ? "text-warn-text" : "text-l3"}`}
      >
        覆盖检查：AI 写的 / Mesa 数的{off > 0 ? ` · ${off} 节对不上` : " · 都对得上"}
        {open ? " 收起" : " 展开"}
      </button>
      {open && (
        <table className="mt-1 w-full border-collapse">
          <thead>
            <tr className="text-l4">
              <th className="px-1.5 py-0.5 text-left font-normal">节</th>
              <th className="px-1.5 py-0.5 text-right font-normal">可写正文</th>
              <th className="px-1.5 py-0.5 text-right font-normal">仅线索</th>
              <th className="px-1.5 py-0.5 text-right font-normal">最新一篇</th>
              <th className="px-1.5 py-0.5 text-left font-normal">判断（AI）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.mismatch ? "bg-strip" : undefined}>
                <td
                  className="max-w-[16rem] truncate px-1.5 py-0.5 text-l2"
                  title={r.mesa ? r.label : `${r.label}（大纲里找不到这一节的拟引用，Mesa 没法数）`}
                >
                  {r.label}
                </td>
                {cell(r.ai.writable, r.mesa?.writable.length)}
                {cell(r.ai.hint, r.mesa?.hint.length)}
                <td className="px-1.5 py-0.5 text-right tabular-nums text-l3">
                  {r.ai.latest || "?"}
                  <span className="text-l4"> / </span>
                  {r.mesa?.latest ?? "—"}
                </td>
                <td className="max-w-[12rem] truncate px-1.5 py-0.5 text-l3" title={r.ai.verdict}>
                  {r.ai.verdict}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
