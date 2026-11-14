import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark, NoticeBar, projectWellClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { IS_WINDOWS } from "../hotkeys";
import { filterPortsForRepo } from "../project-status";
import type { PortInfoDto } from "../types";

const OWNER_RANK: Record<PortInfoDto["ownerKind"], number> = {
  workspace: 0,
  project: 1,
  range: 2,
  other: 3,
};

export default function PortsSection({
  roots,
}: {
  roots: string[];
}) {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<PortInfoDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const all = await invoke<PortInfoDto[]>("list_listening_ports");
      setPorts(filterPortsForRepo(all, roots, IS_WINDOWS));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots.join("\n")]);

  async function onKill(port: PortInfoDto) {
    if (
      port.ownerKind === "other" &&
      !(await confirmDialog(
        `结束「${port.process || "未知进程"}」？\n\n它不是 Mesa 启动的（端口 ${port.port}），结束可能影响别的应用。`,
        { danger: true },
      ))
    )
      return;
    setKilling(port.pid);
    setError(null);
    try {
      await invoke("kill_port_process", { pid: port.pid });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setKilling(null);
    }
  }

  const list = useMemo(() => {
    const items = [...(ports ?? [])];
    items.sort(
      (a, b) =>
        OWNER_RANK[a.ownerKind] - OWNER_RANK[b.ownerKind] || a.port - b.port,
    );
    return items;
  }, [ports]);

  if (!open && list.length === 0 && !error) return null;

  const dotClass: Record<PortInfoDto["ownerKind"], string> = {
    workspace: "bg-ok-text",
    project: "bg-ok-text",
    range: "bg-warn-text",
    other: "bg-l4",
  };

  const previewPorts = list.slice(0, 3);
  const hiddenCount = Math.max(0, list.length - previewPorts.length);

  return (
    <section className={`${projectWellClass} overflow-hidden p-0`}>
      <div className="flex min-h-10 items-center gap-2 px-3 py-1.5 transition-colors hover:bg-hover/60">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
        >
          <FoldMark open={open} boxed />
          <h2 className="text-xs font-medium text-l2">监听端口</h2>
          {list.length > 0 && (
            <span className="rounded-md border border-hairline bg-inset/75 px-1.5 py-0.5 font-mono text-micro tabular-nums text-l3">
              {list.length}
            </span>
          )}
          {!open && previewPorts.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {previewPorts.map((port) => (
                <span
                  key={`preview-${port.pid}-${port.port}`}
                  className="inline-flex h-5 items-center gap-1.5 rounded-md border border-hairline bg-inset/70 px-2 font-mono text-micro tabular-nums text-l2"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${dotClass[port.ownerKind]}`}
                    aria-hidden="true"
                  />
                  <span>:{port.port}</span>
                  {port.process && (
                    <span className="max-w-24 truncate font-sans text-l3">
                      {port.process}
                    </span>
                  )}
                </span>
              ))}
              {hiddenCount > 0 && (
                <span className="text-micro tabular-nums text-l4">
                  +{hiddenCount} 个
                </span>
              )}
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-hairline px-2 py-2">
          {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
          {list.length === 0 && !loading && (
            <p className="px-2 py-1.5 text-xs text-l4">这个项目没有监听中的端口。</p>
          )}
          {list.length > 0 && (
            <div>
              <div className="grid grid-cols-[4.5rem_7.5rem_6.5rem_minmax(0,1fr)_auto] items-center gap-2 px-2.5 pb-1 text-micro text-l4">
                <span>端口</span>
                <span>进程</span>
                <span>归属</span>
                <span>工作目录</span>
                <span>操作</span>
              </div>
              <ul className="space-y-0.5">
                {list.map((port) => (
                  <li
                    key={`${port.pid}-${port.port}`}
                    className="grid min-h-9 grid-cols-[4.5rem_7.5rem_6.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-1 transition-colors hover:bg-hover"
                  >
                    <span className="font-mono text-xs font-medium tabular-nums text-l1">
                      :{port.port}
                    </span>
                    <span
                      className="truncate text-xs text-l2"
                      title={`PID ${port.pid}`}
                    >
                      {port.process || "进程"}{" "}
                      <span className="font-mono text-micro tabular-nums text-l4">
                        #{port.pid}
                      </span>
                    </span>
                    <span className="inline-flex h-5 w-fit max-w-full items-center gap-1.5 truncate rounded-md border border-hairline bg-inset/75 px-2 text-micro text-l2">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${dotClass[port.ownerKind]}`}
                      />
                      <span className="truncate">{port.ownerLabel}</span>
                    </span>
                    <span
                      className="min-w-0 truncate font-mono text-micro text-l4"
                      title={port.cwd ?? ""}
                    >
                      {port.cwd ?? "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onKill(port)}
                      disabled={killing === port.pid}
                      className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-err-text disabled:opacity-50"
                    >
                      {killing === port.pid ? "终止中…" : "终止"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
