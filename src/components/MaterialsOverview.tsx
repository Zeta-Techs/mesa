import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark } from "./PageFrame";
import { readResearchFile, readResearchLedger } from "../research-report-load";
import { toast } from "../toast";
import type { SkillProvides } from "../skill-slots";
import type { ReworkDto } from "../step-loop";
import {
  assetCounts,
  assetFilesFor,
  overviewRow,
  overviewSummary,
  reworkLine,
  type AssetFiles,
  type OverviewRow,
} from "../materials-overview";
import { KIND_ASSET, stepKind } from "../step-kind";
import type { ProjectStepDto, WorkspaceDto } from "../types";

const TONE: Record<OverviewRow["align"]["tone"], string> = {
  ok: "text-l3",
  warn: "text-warn-text",
  idle: "text-l4",
};

/**
 * 资料全貌（2026-11-06 流程贯通 §7，design-flow-weave.md）：项目页流程线上方一块，一行一份资料——现状（从文件机械数）、
 * 跟上游对齐没有，下面列在途的回头（补料单补到哪、链等谁，可「停掉这条链」）。两步以上开过工才出；
 * 有没跟上的或在途的回头时默认展开，否则折成一行。点步骤名跳到那一步，跟进 / 退回在步骤卡上点。
 */
export default function MaterialsOverview({
  projectPath,
  steps,
  statuses,
  provides,
  focusIndex,
  onFocus,
  refreshKey,
}: {
  projectPath: string;
  steps: ProjectStepDto[];
  statuses: { key: string; ws?: WorkspaceDto }[];
  provides: SkillProvides;
  focusIndex: number | null;
  onFocus: (index: number) => void;
  refreshKey: string;
}) {
  /** 每一步的机械计数（按步骤名；读不到的没有） */
  const [counts, setCounts] = useState<Record<string, string | null>>({});
  const [reworks, setReworks] = useState<ReworkDto[]>([]);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);

  const kinds = steps.map((st) => stepKind(st, provides));
  // 开过工的步骤要读哪些文件：同一份文件只读一次（检索和精读都要 included.json）
  const plan = steps
    .map((st, i) => ({ st, kind: kinds[i], started: !!statuses[i]?.key && statuses[i].key !== "pending" }))
    .filter((x) => x.started)
    .map((x) => ({ name: x.st.name, kind: x.kind, files: assetFilesFor(x.kind, x.st.expectedArtifacts ?? []) }));
  const planKey = plan.map((p) => `${p.name}:${p.kind}:${p.files.map((f) => f.path).join("+")}`).join("|");

  useEffect(() => {
    let stale = false;
    const read = async (path: string, ledger?: boolean) => {
      try {
        const f = ledger ? await readResearchLedger(projectPath, path) : await readResearchFile(projectPath, path);
        return f.truncated ? null : f.text;
      } catch {
        return null;
      }
    };
    void (async () => {
      const paths = new Map<string, { ledger?: boolean }>();
      for (const p of plan) for (const f of p.files) paths.set(f.path, { ledger: f.ledger });
      const texts = new Map<string, string | null>();
      await Promise.all([...paths].map(async ([path, o]) => texts.set(path, await read(path, o.ledger))));
      const list = await invoke<ReworkDto[]>("rework_list", { root: projectPath }).catch(() => [] as ReworkDto[]);
      if (stale) return;
      const next: Record<string, string | null> = {};
      for (const p of plan) {
        const files: AssetFiles = { reports: [] };
        for (const f of p.files) {
          const text = texts.get(f.path) ?? null;
          if (f.key === "reports") {
            if (text) files.reports!.push(text);
          } else files[f.key] = text;
        }
        next[p.name] = assetCounts(p.kind, files);
      }
      setCounts(next);
      setReworks(list);
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, refreshKey, tick, planKey]);

  const savedAt = (name: string) => {
    const i = steps.findIndex((st) => st.name === name);
    return statuses[i]?.ws?.mergedAt ?? null;
  };
  const rows: { index: number; row: OverviewRow }[] = [];
  steps.forEach((st, i) => {
    const s = statuses[i];
    if (!s) return;
    const row = overviewRow({
      name: st.name,
      asset: KIND_ASSET[kinds[i]],
      key: s.key,
      staleUpstream: s.ws?.staleUpstream ?? null,
      mergedAt: s.ws?.mergedAt ?? null,
      counts: counts[st.name] ?? null,
    });
    if (row) rows.push({ index: i, row });
  });
  const inFlight = reworks
    .map((r) => ({ r, line: reworkLine(r, savedAt) }))
    .filter((x): x is { r: ReworkDto; line: { text: string; chainActive: boolean } } => !!x.line)
    .slice(0, 4);
  if (rows.length < 2) return null;
  const autoOpen = inFlight.length > 0 || rows.some((x) => x.row.align.tone === "warn");
  const open = userOpen ?? autoOpen;

  async function stopChain(id: string) {
    try {
      await invoke("rework_chain_stop", { root: projectPath, reworkId: id });
      toast("这条链停了：补完的照旧在，后面的步骤到时自己点「跟进上游的新增」。", "info");
      setTick((n) => n + 1);
    } catch (reason) {
      toast(`没停成：${String(reason)}`, "error");
    }
  }

  return (
    <section aria-label="资料全貌" className="mb-2">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        title="前面几步轮流打磨同几份资料：每份现在什么样、跟上游对齐没有、有没有在途的回头"
      >
        <FoldMark open={open} />
        <span className="shrink-0 text-xs font-medium text-l3">资料全貌</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">{overviewSummary(rows.map((x) => x.row), inFlight.length)}</span>
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg ccode-well px-3 py-2 text-xs">
          <ul className="space-y-1">
            {rows.map(({ index, row }) => (
              <li key={row.name} className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(7rem,auto)_5rem_1fr_auto]">
                <button
                  type="button"
                  className={`min-w-0 truncate text-left ${focusIndex === index ? "text-l1" : "text-l2 hover:text-l1"}`}
                  title={focusIndex === index ? "正在看这一步" : "去这一步"}
                  onClick={() => onFocus(index)}
                >
                  {row.name}
                  {row.asset && <span className="text-l4"> · {row.asset}</span>}
                </button>
                <span className="text-l3">{row.state}</span>
                <span className="min-w-0 truncate tabular-nums text-l3" title={row.counts ?? undefined}>
                  {row.counts ?? ""}
                </span>
                <span className={`min-w-0 truncate ${TONE[row.align.tone]}`}>{row.align.text}</span>
              </li>
            ))}
          </ul>
          {inFlight.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-hairline pt-2">
              {inFlight.map(({ r, line }) => (
                <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-l2">
                  <span className="min-w-0">{line.text}</span>
                  {line.chainActive && (
                    <button
                      type="button"
                      className="shrink-0 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                      title="只停自动往下：补料单和已经开的轮不动，后面的步骤到时自己点「跟进上游的新增」"
                      onClick={() => void stopChain(r.id)}
                    >
                      停掉这条链
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
