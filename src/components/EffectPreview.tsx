import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark } from "./PageFrame";
import type { GlobalWritePreviewDto, LaunchPlanPreviewDto } from "../types";

/**
 * 连接弹层底部「生效预览」（2026-10-30 用户拍板，docs/design-connection-agent-forms.md §4）：默认折叠成一行，
 * 展开后两栏——在 Mesa 里启动时注入什么（preview_launch_plan，只列变量名）、设为全局后外面直接用时写哪些文件哪些键
 * （preview_profile_global，已脱敏，附带不会生效的项与会被盖掉的来源）。按**已保存**的连接算：改了要先保存才看得到。
 */
export function EffectPreview({ profileId, setGlobalReason }: { profileId: string; setGlobalReason: string | null }) {
  const [open, setOpen] = useState(false);
  const [launch, setLaunch] = useState<LaunchPlanPreviewDto | string | null>(null);
  const [global, setGlobal] = useState<GlobalWritePreviewDto | string | null>(null);

  async function load() {
    setLaunch(null);
    setGlobal(null);
    const [l, g] = await Promise.allSettled([
      invoke<LaunchPlanPreviewDto>("preview_launch_plan", { profileId, model: null }),
      setGlobalReason
        ? Promise.reject(setGlobalReason)
        : invoke<GlobalWritePreviewDto>("preview_profile_global", { profileId }),
    ]);
    setLaunch(l.status === "fulfilled" ? l.value : String(l.reason));
    setGlobal(g.status === "fulfilled" ? g.value : String(g.reason));
  }

  return (
    <details
      className="mb-4 rounded-md border border-hairline px-3 py-2"
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (next) void load();
      }}
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-xs text-l2 [&::-webkit-details-marker]:hidden">
        <FoldMark open={open} />
        <span>看实际会拿到什么</span>
        <span className="text-micro text-l3">按已保存的内容算，改了先保存</span>
      </summary>
      {open && (
        <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
          <section className="min-w-0">
            <p className="mb-1 font-medium text-l2">在 Mesa 里启动</p>
            {launch === null ? (
              <p className="text-l3">◌ 正在算…</p>
            ) : typeof launch === "string" ? (
              <p className="text-l3">{launch}</p>
            ) : (
              <div className="space-y-1.5">
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
                {launch.notes.map((n) => (
                  <p key={n} className="text-micro leading-4 text-l3">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </section>
          <section className="min-w-0">
            <p className="mb-1 font-medium text-l2">设为全局后外面直接用</p>
            {global === null ? (
              <p className="text-l3">◌ 正在算…</p>
            ) : typeof global === "string" ? (
              <p className="text-l3">{global}</p>
            ) : (
              <div className="space-y-1.5">
                {global.files.length === 0 && <p className="text-l3">磁盘已是这份配置。</p>}
                {global.files.map((f) => (
                  <div key={f.path}>
                    <p className="text-l2">{f.path}</p>
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
                ))}
                {[...global.skippedPolicies, ...global.overrideNotes].map((n) => (
                  <p key={n} className="text-micro leading-4 text-l3">
                    · {n}
                  </p>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </details>
  );
}
