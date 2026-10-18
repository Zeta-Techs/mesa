import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { agentBrandBadgeStyle } from "../agent-colors";
import { IS_WINDOWS } from "../hotkeys";
import {
  canApply,
  cwdDiffersFromProject,
  defaultDecisions,
  importStatusLabel,
  type EntryDecision,
} from "../session-transfer";
import { AGENTS } from "../types";
import type { ImportPreviewDto, ImportReportDto } from "../types";
import { Checkbox, fieldClass, primaryActionClass, rowActionClass, InlineNotice } from "./PageFrame";
import { Modal } from "./Modal";

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

export default function SessionImportModal({
  registeredPaths,
  onClose,
  onImported,
}: {
  registeredPaths: string[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [decisions, setDecisions] = useState<Record<number, EntryDecision>>(
    {},
  );
  const [registerToClient, setRegisterToClient] = useState(true);
  const [registerBindingId, setRegisterBindingId] = useState<string>("");
  const [report, setReport] = useState<ImportReportDto | null>(null);

  const bindings = preview?.codexBindings ?? [];
  const needsRegister = preview?.entries.some((e) => e.needsClientRegister) ?? false;

  useEffect(() => {
    if (bindings.length === 0) return;
    const withKey = bindings.find((b) => b.hasKey) ?? bindings[0];
    setRegisterBindingId((cur) => cur || withKey.id);
    setRegisterToClient(bindings.some((b) => b.hasKey));
  }, [bindings]);

  async function pickZip() {
    setError(null);
    setReport(null);
    const path = await open({
      multiple: false,
      filters: [{ name: "Mesa 会话包", extensions: ["zip"] }],
    });
    if (!path || Array.isArray(path)) return;
    setBusy(true);
    try {
      const p = await invoke<ImportPreviewDto>("import_sessions_inspect", {
        zipPath: path,
      });
      setZipPath(path);
      setPreview(p);
      setDecisions(defaultDecisions(p.entries, registeredPaths, IS_WINDOWS));
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function pickDir(index: number) {
    const path = await open({ directory: true, multiple: false });
    if (!path || Array.isArray(path)) return;
    setDecisions((prev) => ({
      ...prev,
      [index]: { ...(prev[index] ?? { skip: false, targetDir: "" }), targetDir: path },
    }));
  }

  const ready = useMemo(
    () => (preview ? canApply(preview.entries, decisions) : { ok: false, missing: [] }),
    [preview, decisions],
  );

  async function apply() {
    if (!zipPath || !preview || !ready.ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<ImportReportDto>("import_sessions_apply", {
        zipPath,
        decisions: preview.entries.map((e) => ({
          index: e.index,
          skip: decisions[e.index]?.skip ?? false,
          targetDir: decisions[e.index]?.targetDir || null,
        })),
        registerBindingId: registerToClient ? registerBindingId || null : null,
        registerToClient: registerToClient && needsRegister && !!registerBindingId,
      });
      setReport(res);
      if (res.imported > 0) onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="导入会话"
      onClose={onClose}
      size="md"
      panelClassName="z-60 max-h-[min(640px,90vh)]"
      contentClassName="min-h-0 flex-1 overflow-y-auto text-sm"
      footer={
        <>
          {preview && !report && (
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy || !ready.ok}
              onClick={() => void apply()}
            >
              {busy ? "导入中…" : "开始导入"}
            </button>
          )}
          {report && (
            <button type="button" className={primaryActionClass} onClick={onClose}>
              完成
            </button>
          )}
        </>
      }
    >
        <div className="text-sm">
          {error && <InlineNotice tone="err" className="mb-2">{error}</InlineNotice>}
          {!preview && !report && (
            <div className="space-y-2">
              <p className="text-xs text-l3">
                选择另一台机器导出的 <span className="font-mono">.ccode-sessions.zip</span>。
                不会导入密钥或连接配置。OpenCode 会话不支持。
              </p>
              <button
                type="button"
                className={primaryActionClass}
                disabled={busy}
                onClick={() => void pickZip()}
              >
                {busy ? "解析中…" : "选择会话包"}
              </button>
            </div>
          )}
          {preview && !report && (
            <div className="space-y-3">
              <p className="text-xs text-l4">
                导出于 {preview.exportedAt} · 来源版本 {preview.appVersion}
              </p>
              <ul className="space-y-2">
                {preview.entries.map((e) => {
                  const d = decisions[e.index] ?? { skip: false, targetDir: "" };
                  const locked = e.status === "conflict" || e.status === "unsupported";
                  return (
                    <li
                      key={`${e.agent}:${e.sessionId}`}
                      className="rounded-sm ccode-well px-2.5 py-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="shrink-0 rounded-full px-1.5 py-px text-micro font-medium"
                              style={agentBrandBadgeStyle(e.agent)}
                            >
                              {agentLabel(e.agent)}
                            </span>
                            <span className="truncate text-l1">
                              {e.title || e.sessionId.slice(0, 8)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate font-mono text-micro text-l4" title={e.projectPath}>
                            {e.projectPath || "（无原路径）"}
                          </p>
                          {cwdDiffersFromProject(e, IS_WINDOWS) && e.cwd && (
                            <p
                              className="mt-0.5 truncate font-mono text-micro text-l4"
                              title={e.cwd}
                            >
                              工作区 {e.cwd}
                            </p>
                          )}
                          <p
                            className={`mt-0.5 text-micro ${
                              e.status === "unsupported" || e.status === "conflict"
                                ? "text-err-text"
                                : e.status === "needs-path"
                                  ? "text-warn-text"
                                  : "text-l3"
                            }`}
                          >
                            {importStatusLabel(e.status)}
                            {e.reason ? ` · ${e.reason}` : ""}
                          </p>
                        </div>
                      </div>
                      {e.status === "needs-path" && !locked && (
                        <div className="mt-1.5 flex items-center gap-1">
                          <input
                            className={`min-w-0 flex-1 ${fieldClass}`}
                            placeholder="选择本机项目目录"
                            value={d.targetDir}
                            onChange={(ev) =>
                              setDecisions((prev) => ({
                                ...prev,
                                [e.index]: { ...d, targetDir: ev.target.value },
                              }))
                            }
                          />
                          <button
                            type="button"
                            className={rowActionClass}
                            onClick={() => void pickDir(e.index)}
                          >
                            浏览
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {needsRegister && (
                <div className="rounded-sm border border-hairline px-2.5 py-2">
                  <Checkbox
                    checked={registerToClient}
                    onChange={setRegisterToClient}
                    disabled={bindings.length === 0}
                    label="注册到 Codex 客户端"
                  />
                  <p className="mt-1 text-micro text-l4">
                    会话记的是另一台机器的渠道名。勾选后用本机连接写同名定义，桌面客户端才能打开。
                  </p>
                  {registerToClient && (
                    <select
                      className={`mt-1.5 w-full ${fieldClass}`}
                      value={registerBindingId}
                      onChange={(ev) => setRegisterBindingId(ev.target.value)}
                    >
                      {bindings.map((b) => (
                        <option key={b.id} value={b.id} disabled={!b.hasKey}>
                          {b.name}
                          {b.hasKey ? "" : "（无密钥）"}
                        </option>
                      ))}
                    </select>
                  )}
                  {bindings.length === 0 && (
                    <p className="mt-1 text-micro text-l4">
                      没有带端点的 Codex 连接，导入后仍可在 Mesa 终端恢复。
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {report && (
            <div className="space-y-2">
              <p className="text-l2">
                导入 {report.imported} · 跳过 {report.skipped} · 失败 {report.failed}
              </p>
              {report.registerNote && (
                <p className="text-xs text-l3">{report.registerNote}</p>
              )}
              <ul className="space-y-1 text-xs text-l3">
                {report.items
                  .filter((i) => i.status !== "imported")
                  .map((i) => (
                    <li key={`${i.agent}:${i.sessionId}`}>
                      {agentLabel(i.agent)} · {i.sessionId.slice(0, 8)} · {i.status}
                      {i.reason ? ` · ${i.reason}` : ""}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
    </Modal>
  );
}
