import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark } from "./PageFrame";
import type { EffectCellDto, EffectPreviewDto } from "../types";

/**
 * 连接弹层底部「实际生效的设置」（2026-11-07 由「看实际会拿到什么」改名：用户看不懂在说什么）：默认折叠成一行，展开是逐项对照表（2026-11-01 用户：原来左边命令行原文、
 * 右边只列差异，对比看不出什么）。每行一项（地址 / 默认模型 / 密钥 / 上下文窗口 / 请求参数），
 * 左列在 Mesa 里启动时落在哪、右列设为全局后外面直接用时落在哪，两边不一致的行标出来。
 * 数据来自 preview_effect（effect_preview.rs），按**已保存**的连接算；命令行原文与文件改动收在表下折叠行。
 */
export function EffectPreview({ profileId, setGlobalReason }: { profileId: string; setGlobalReason: string | null }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EffectPreviewDto | string | null>(null);

  async function load() {
    setData(null);
    try {
      setData(await invoke<EffectPreviewDto>("preview_effect", { profileId }));
    } catch (e) {
      setData(String(e));
    }
  }

  return (
    <details
      className="mb-4 rounded-md border border-hairline px-3 py-2"
      onToggle={(e) => {
        // 表下「原始参数与文件改动」也是 <details>，它的 toggle 会沿 React 树冒到这里：
        // 不拦的话外层当成自己展开、重新取数，整张表重挂，里面那层刚展开就被收回（2026-11-01 用户：点了没反应）
        if (e.target !== e.currentTarget) return;
        const next = e.currentTarget.open;
        setOpen(next);
        if (next) void load();
      }}
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-xs text-l2 [&::-webkit-details-marker]:hidden">
        <FoldMark open={open} />
        <span>实际生效的设置</span>
        <span className="min-w-0 truncate text-micro text-l3">在 Mesa 里启动、设为全局后，各用哪个地址、模型和密钥（按已保存的内容算）</span>
      </summary>
      {open &&
        (data === null ? (
          <p className="mt-2 text-xs text-l3">◌ 正在算…</p>
        ) : typeof data === "string" ? (
          <p className="mt-2 text-xs text-l3">{data}</p>
        ) : (
          <EffectTable data={data} setGlobalReason={setGlobalReason} />
        ))}
    </details>
  );
}

function EffectTable({ data, setGlobalReason }: { data: EffectPreviewDto; setGlobalReason: string | null }) {
  const globalError = setGlobalReason ?? data.globalError;
  const differs = data.rows.filter((r) => r.differs).length;
  const launchNotes = data.launch?.notes ?? [];
  const globalNotes = [...(data.global?.skippedPolicies ?? []), ...(data.global?.overrideNotes ?? [])];
  const changes = data.global?.files.reduce((n, f) => n + f.changes.length + f.omitted, 0) ?? 0;

  return (
    <div className="mt-2 space-y-3 text-xs">
      <p className="text-micro leading-4 text-l3">
        {globalError
          ? `外面直接用：${globalError}`
          : data.globalUnchanged
            ? "这条连接已是全局默认，右列就是外面现在读到的。"
            : `右列是设为全局后外面会读到的（现在还要改 ${changes} 处）。`}
        {differs > 0 && <span className="text-caution-text"> 有 {differs} 项两边不一样。</span>}
      </p>

      <div className="overflow-hidden rounded-md border border-hairline">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-hairline bg-hover/50 px-2.5 py-1.5 text-micro font-medium text-l3">
          <span>项</span>
          <span>在 Mesa 里启动</span>
          <span>设为全局后外面直接用</span>
        </div>
        {data.rows.length === 0 && <p className="px-2.5 py-2 text-l3">这条连接没有要对照的项。</p>}
        {data.rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-hairline px-2.5 py-2 last:border-b-0"
          >
            <span className={r.differs ? "text-caution-text" : "text-l2"}>
              {r.label}
              {r.differs && <span className="block text-micro">不一样</span>}
            </span>
            <Cell cell={r.launch} error={data.launchError} empty="不注入，照读 CLI 自己的配置" />
            <Cell cell={r.global} error={globalError} empty="不写" />
          </div>
        ))}
      </div>

      {(data.launchError || launchNotes.length > 0 || globalNotes.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Notes title="在 Mesa 里启动时" notes={data.launchError ? [data.launchError, ...launchNotes] : launchNotes} />
          <Notes title="外面直接用时" notes={globalNotes} />
        </div>
      )}

      <RawDetails data={data} />
    </div>
  );
}

function Cell({ cell, error, empty }: { cell: EffectCellDto; error: string | null; empty: string }) {
  if (error) return <span className="text-l4">—</span>;
  if (!cell.value) return <span className="text-l4">{empty}</span>;
  return (
    <span className="min-w-0">
      <span className="block break-all font-mono text-l1">{cell.value}</span>
      {cell.via && <span className="mt-0.5 block break-all text-micro leading-4 text-l4">{cell.via}</span>}
    </span>
  );
}

function Notes({ title, notes }: { title: string; notes: string[] }) {
  if (notes.length === 0) return <div />;
  return (
    <section className="min-w-0">
      <p className="mb-1 text-micro font-medium text-l3">{title}</p>
      <ul className="space-y-0.5">
        {notes.map((n) => (
          <li key={n} className="text-micro leading-4 text-l3">
            · {n}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 命令行原文与文件改动：排查时才看，收在折叠行里 */
function RawDetails({ data }: { data: EffectPreviewDto }) {
  const [open, setOpen] = useState(false);
  const launch = data.launch;
  const global = data.global;
  if (!launch && !global) return null;
  return (
    <details
      onToggle={(e) => {
        e.stopPropagation();
        setOpen(e.currentTarget.open);
      }}
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-micro text-l3 [&::-webkit-details-marker]:hidden">
        <FoldMark open={open} />
        <span>原始参数与文件改动</span>
      </summary>
      {open && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <section className="min-w-0 space-y-1.5">
            <p className="text-micro font-medium text-l3">启动参数与环境变量</p>
            {launch ? (
              <>
                {launch.args.length > 0 && (
                  <p className="break-all font-mono text-micro text-l3">{launch.args.join(" ")}</p>
                )}
                {launch.env.length > 0 && (
                  <ul className="space-y-0.5 font-mono text-micro text-l3">
                    {launch.env.map((e, i) => (
                      <li key={`${e.name}-${i}`} className="break-all">
                        {e.name} <span className="font-sans text-l4">· {e.source}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-micro text-l4">—</p>
            )}
          </section>
          <section className="min-w-0 space-y-1.5">
            <p className="text-micro font-medium text-l3">设为全局要改的</p>
            {!global ? (
              <p className="text-micro text-l4">—</p>
            ) : global.files.length === 0 ? (
              <p className="text-micro text-l4">磁盘已是这份配置，不用改。</p>
            ) : (
              global.files.map((f) => (
                <div key={f.path}>
                  <p className="text-micro text-l2">{f.path}</p>
                  <ul className="space-y-0.5 font-mono text-micro text-l3">
                    {f.changes.map((c) => (
                      <li key={`${c.op}:${c.path}`} className="break-all">
                        {c.op === "remove" ? "撤" : c.op === "add" ? "加" : "改"} {c.path}
                        {c.op !== "remove" && c.after ? ` → ${c.after}` : ""}
                      </li>
                    ))}
                  </ul>
                  {f.omitted > 0 && <p className="text-micro text-l4">另有 {f.omitted} 项未列出</p>}
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </details>
  );
}
