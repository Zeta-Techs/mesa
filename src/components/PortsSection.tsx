import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark, NoticeBar } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { IS_WINDOWS } from "../hotkeys";
import { filterPortsForRepo } from "../project-status";
import type { PortInfoDto } from "../types";

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
        `「${port.process || "未知进程"}」不是 Mesa 启动的进程（PID ${port.pid}，端口 ${port.port}）。终止它可能影响其他正在运行的应用。继续？`,
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

  const list = ports ?? [];
  if (!open && list.length === 0 && !error) return null;

  const dotClass: Record<PortInfoDto["ownerKind"], string> = {
    workspace: "bg-ok-text",
    project: "bg-ok-text",
    range: "bg-warn-text",
    other: "bg-l4",
  };

  return (
    <section>
      <div className="flex h-8 items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FoldMark open={open} boxed />
          <h2 className="text-xs font-medium text-l2">端口</h2>
          {list.length > 0 && (
            <span className="text-micro text-l4">{list.length} 个监听中</span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="mr-2 inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
          {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
          {list.length === 0 && !loading && (
            <p className="px-1 py-2 text-xs text-l4">这个项目没有监听中的端口。</p>
          )}
          {list.length > 0 && (
            <ul className="space-y-0.5">
              {list.map((port) => (
                <li
                  key={`${port.pid}-${port.port}`}
                  className="flex min-h-10 items-center gap-2 rounded-md px-2.5"
                >
                  <span className="w-12 shrink-0 font-mono text-sm text-l1">
                    {port.port}
                  </span>
                  <span
                    className="w-28 shrink-0 truncate text-xs text-l2"
                    title={`PID ${port.pid}`}
                  >
                    {port.process || `PID ${port.pid}`}
                  </span>
                  <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-inset px-2 text-xs text-l2">
                    <span
                      className={`size-2 rounded-full ${dotClass[port.ownerKind]}`}
                    />
                    {port.ownerLabel}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-micro text-l4"
                    title={port.cwd ?? ""}
                  >
                    {port.cwd ?? ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onKill(port)}
                    disabled={killing === port.pid}
                    className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-err-text disabled:opacity-50"
                  >
                    {killing === port.pid ? "终止中…" : "终止"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
