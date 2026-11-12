import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { fieldClass, InlineNotice, secondaryActionClass } from "./PageFrame";
import { projectFilePreviewKind } from "../project-files";
import { showProjectFile } from "../project-file-open";
import { lineDiff } from "../tool-activity";
import { roundCauseLabel, roundTime } from "../step-loop";
import type { FileVersionsDto, VersionFile } from "../types";
import { FileSelectionTree } from "./FileTree";

const ProjectFilePreview = lazy(() => import("./ProjectFilePreview"));
const LINK = "shrink-0 rounded-sm text-xs text-l3 underline-offset-2 hover:text-l1 hover:underline disabled:opacity-40";
const absolute = (root: string, path: string) => `${root.replace(/[/\\]+$/, "")}/${path}`;

export function FileVersionsButton({ root, path, workspaceId, refreshKey = "", lead, onOpen }: {
  root: string;
  path?: string;
  workspaceId?: string;
  refreshKey?: string;
  lead?: ReactNode;
  onOpen?: () => void | Promise<void>;
}) {
  const [data, setData] = useState<FileVersionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    invoke<FileVersionsDto>("file_versions", { root, path: path ?? null, workspaceId: workspaceId ?? null })
      .then((value) => { if (!stale) { setData(value); setError(null); } })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [root, path, workspaceId, refreshKey]);
  if (!data?.files?.length && !workspaceId) return lead ? <>{lead}</> : null;
  if (!data?.files?.length && !error) return lead ? <>{lead}</> : null;
  async function open() {
    if (onOpen) { await onOpen(); return; }
    if (!data?.files.length) return;
    const first = data.files.find((file) => file.exists || file.versions.length) ?? data.files[0];
    try {
      await showProjectFile({ projectRoot: data.root, root: data.root, path: absolute(data.root, first.path), versions: { root, workspaceId }, from: "文件版本" });
    } catch (reason) { setError(String(reason)); }
  }
  return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
    {lead}
    {lead && <span aria-hidden="true" className="text-xs text-l4">·</span>}
    <button type="button" className={LINK} onClick={() => void open()} title={error ?? "在右侧文件栏查看现稿和历史；留存只决定以后保存哪些版本"}>文件版本</button>
  </span>;
}

export function FileVersionsPanel({ root, path, workspaceId, onClose }: {
  root: string;
  path?: string;
  workspaceId?: string;
  onClose?: (currentPath?: string) => void;
}) {
  const [data, setData] = useState<FileVersionsDto | null>(null);
  const [file, setFile] = useState<VersionFile | null>(null);
  const [chosen, setChosen] = useState("");
  const [versionId, setVersionId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [otherPreview, setOtherPreview] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"snapshot" | "rename" | "export" | null>(null);
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [treeOpen, setTreeOpen] = useState(!path);
  const paths = useMemo(() => data?.files.map((file) => file.path) ?? [], [data]);
  const version = file?.versions.find((candidate) => candidate.id === versionId);
  const compared = file?.versions.find((candidate) => candidate.id === compareId);
  const kind = projectFilePreviewKind(chosen);
  const retained = !!version && !version.id.startsWith("git:");
  const lines = useMemo(() => diff && diff.before !== diff.after ? lineDiff(diff.before, diff.after) : [], [diff]);
  useEffect(() => {
    let stale = false;
    setData(null); setFile(null); setError(null);
    invoke<FileVersionsDto>("file_versions", { root, path: path ?? null, workspaceId: workspaceId ?? null }).then((next) => {
      if (stale) return;
      setData(next);
      setChosen((current) => next.files.some((file) => file.path === current) ? current : (next.files.find((file) => file.exists || file.versions.length) ?? next.files[0])?.path ?? "");
    }).catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [root, path, workspaceId, revision]);
  useEffect(() => {
    let stale = false;
    setFile(null); setPreview(null); setOtherPreview(null); setDiff(null); setCompareId("");
    if (!chosen) return;
    invoke<FileVersionsDto>("file_versions", { root, path: chosen, workspaceId: workspaceId ?? null }).then((next) => {
      if (stale) return;
      const selected = next.files[0] ?? null;
      setFile(selected);
      setVersionId(selected?.exists ? "" : selected?.versions[0]?.id ?? "");
    }).catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [root, chosen, workspaceId, revision]);
  useEffect(() => {
    let stale = false;
    setPreview(null); setOtherPreview(null); setDiff(null);
    if (!file || !data) return;
    setError(null);
    if (!versionId) {
      if (file.exists) setPreview(path ?? absolute(root, chosen));
      return;
    }
    if (!version) return;
    const request = compareId && kind !== "image"
      ? invoke<{ before: string; after: string }>("file_version_diff", { root: data.root, from: compareId, to: version.id }).then((result) => { if (!stale) setDiff(result); })
      : Promise.all([
        invoke<string>("file_version_preview", { root: data.root, versionId: version.id }),
        compareId ? invoke<string>("file_version_preview", { root: data.root, versionId: compareId }) : Promise.resolve(null),
      ]).then(([current, other]) => { if (!stale) { setPreview(current); setOtherPreview(other); } });
    request.catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [file, data?.root, chosen, path, root, versionId, compareId, kind]);
  async function update(action: string, note = "") {
    if (!file || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await invoke("file_version_update", { root, path: path ?? file.path, action, versionId: version?.id ?? null, note, workspaceId: workspaceId ?? null });
      setRevision((current) => current + 1); setForm(null);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!version || !(await confirmDialog("删除这一版留存？\n只删这一版记录和不再被其他版本使用的副本，当前文件和 Git 历史不变。", { danger: true, confirmText: "删除留存", focusCancel: true }))) return;
    await update("delete");
  }
  async function submit() {
    if (form !== "export") { await update(form ?? "snapshot", value); return; }
    if (!version || !data) return;
    setBusy(true); setError(null);
    try {
      const target = await invoke<string>("file_version_export", { root: data.root, versionId: version.id, target: value.trim() });
      setNotice(`已另存：${target}。当前文件未替换。`); setForm(null);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section aria-label="文件版本" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
    <div className="flex shrink-0 items-center gap-2 px-2 pt-1">
      {!path && <button type="button" className={LINK} aria-expanded={treeOpen} onClick={() => setTreeOpen((current) => !current)}>文件树</button>}
      <span className="min-w-0 truncate text-xs text-l3" title={chosen}>{chosen.split(/[\\/]/).pop()}</span>
      {onClose && <button type="button" className={`${LINK} ml-auto`} onClick={() => onClose(path ?? absolute(root, chosen))}>返回文件</button>}
    </div>
    <div className="flex min-h-0 flex-1 gap-2">
      {!path && treeOpen && <aside className="flex min-h-0 w-44 shrink-0 flex-col border-r border-hairline">
        <FileSelectionTree paths={paths} selected={chosen} onSelect={(next) => { setChosen(next); setForm(null); setNotice(null); }} />
      </aside>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <div className="shrink-0 space-y-2 px-2 pt-1">
      {file && <>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="查看的版本" className={`${fieldClass} min-w-0 flex-1`} value={versionId} onChange={(event) => { setVersionId(event.target.value); setCompareId(""); setForm(null); }}>
            {file.exists && <option value="">当前文件</option>}
            {file.versions.map((item) => <option key={item.id} value={item.id}>{item.note || roundTime(item.savedAt)} · {item.source}</option>)}
          </select>
          <details className="relative shrink-0">
            <summary className={LINK}>留存与另存</summary>
            <div className="absolute right-0 z-10 mt-1 w-48 space-y-2 rounded-md border border-hairline bg-canvas p-3 shadow-lg" onClick={(event) => {
              const target = event.target as HTMLElement;
              if (!target.closest?.("button")) return;
              const menu = event.currentTarget.closest("details");
              if (menu) menu.open = false;
            }}>
              <label className="flex items-center gap-1.5 text-l3" title="不影响现在能查看哪些历史；取消不删除已留存版本">
                <input type="checkbox" checked={file.tracked} disabled={busy || (!file.exists && !file.tracked)} onChange={() => void update(file.tracked ? "untrack" : "track")} />保留后续版本
              </label>
              <button type="button" className={`${LINK} block`} disabled={busy || !file.exists} onClick={() => { setForm("snapshot"); setValue(""); }}>留存当前这一版…</button>
              {version && <button type="button" className={`${LINK} block`} disabled={busy} onClick={() => { setForm("export"); setValue(chosen.replace(/(\.[^/.]+)?$/, "-副本$1")); }}>另存为副本…</button>}
              {retained && <>
                <button type="button" className={`${LINK} block`} disabled={busy} onClick={() => { setForm("rename"); setValue(version?.note ?? ""); }}>备注…</button>
                <button type="button" className={`${LINK} block`} disabled={busy} onClick={() => void remove()}>删除留存…</button>
              </>}
            </div>
          </details>
        </div>
        {version && <div className="flex flex-wrap items-center gap-2 text-micro text-l4">
          <span>{version.source}{version.round ? ` · 第 ${version.round} 轮` : ""}{version.cause ? ` · ${roundCauseLabel(version.cause)}` : ""} · 只读</span>
          {file.versions.length > 1 && (kind === "text" || kind === "image") && <select aria-label="比较的版本" className={`${fieldClass} ml-auto min-w-0 max-w-full`} value={compareId} onChange={(event) => setCompareId(event.target.value)}>
            <option value="">不比较</option>
            {file.versions.filter((item) => item.id !== versionId).map((item) => <option key={item.id} value={item.id}>对比：{item.note || roundTime(item.savedAt)}</option>)}
          </select>}
        </div>}
        {!file.exists && !file.versions.length && <p className="py-2 text-xs text-l4">当前路径没有文件，也没有可读取的历史；留存不能找回已清理的内容。</p>}
        {form && <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input autoFocus aria-label={form === "export" ? "副本路径" : "版本备注"} className={`${fieldClass} min-w-0 flex-1`} maxLength={form === "export" ? undefined : 200} value={value} onChange={(event) => setValue(event.target.value)} placeholder={form === "export" ? "项目内新文件名，不覆盖已有文件" : "备注（可选）"} />
          <button type="submit" className={secondaryActionClass} disabled={busy || (form === "export" && !value.trim())}>{form === "export" ? "另存" : "保存"}</button>
          <button type="button" className={LINK} disabled={busy} onClick={() => setForm(null)}>取消</button>
        </form>}
      </>}
      {error && <InlineNotice>{error}<button type="button" className={`${LINK} ml-2`} onClick={() => setRevision((current) => current + 1)}>重试</button></InlineNotice>}
      {notice && <p role="status" className="break-all text-xs text-l3">{notice}</p>}
      {!file && !error && <p className="text-xs text-l4">读取中…</p>}
    </div>
    {diff && <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-xs text-l2">
      {diff.before === diff.after ? "两版内容一样。" : lines.map((line, index) => <span key={index} className={`block ${line.op === "+" ? "bg-add/10 text-add" : line.op === "-" ? "bg-del/10 text-del" : ""}`}>{line.op === "~" ? "⋯" : `${line.op} ${line.text}`}</span>)}
    </pre>}
    {preview && <Suspense fallback={<p className="text-xs text-l4">读取中…</p>}>
      <div className={`grid min-h-0 flex-1 gap-2 ${otherPreview ? "grid-cols-2" : "grid-cols-1"}`}>
        {otherPreview && <div className="flex min-h-0 min-w-0 flex-col"><p className="text-xs text-l3">{compared?.note || (compared && roundTime(compared.savedAt))}</p><ProjectFilePreview path={otherPreview} root={otherPreview.replace(/[/\\][^/\\]+$/, "")} readOnly="历史留存只读；要修改请另存为副本" /></div>}
        <ProjectFilePreview key={preview} path={preview} root={versionId ? preview.replace(/[/\\][^/\\]+$/, "") : root} readOnly={versionId ? "历史版本只读；要修改请另存为副本" : "版本查看只读；返回文件后继续编辑"} />
      </div>
    </Suspense>}
      </div>
    </div>
  </section>;
}
