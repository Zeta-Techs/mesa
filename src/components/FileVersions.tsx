import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import { fieldClass, InlineNotice, secondaryActionClass } from "./PageFrame";
import { projectFilePreviewKind } from "../project-files";
import { lineDiff } from "../tool-activity";
import { roundCauseLabel, roundTime } from "../step-loop";
import type { FileVersionsDto, VersionFile } from "../types";

const ProjectFilePreview = lazy(() => import("./ProjectFilePreview"));
const LINK = "shrink-0 rounded-sm text-xs text-l3 underline-offset-2 hover:text-l1 hover:underline";

export function FileVersionsButton({ root, path, workspaceId, refreshKey = "", lead }: {
  root: string;
  path?: string;
  workspaceId?: string;
  refreshKey?: string;
  lead?: ReactNode;
}) {
  const [data, setData] = useState<FileVersionsDto | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    invoke<FileVersionsDto>("file_versions", { root, path: path ?? null, workspaceId: workspaceId ?? null })
      .then((value) => { if (!stale) { setData(value); setError(null); } })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [root, path, workspaceId, refreshKey]);
  const visible = !!data?.files?.length;
  if (!visible && !workspaceId) return lead ? <>{lead}</> : null;
  if (!visible && !error) return lead ? <>{lead}</> : null;
  return <>
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {lead}
      {lead && <span aria-hidden="true" className="text-xs text-l4">·</span>}
      <button type="button" className={LINK} onClick={() => setOpen(true)} title="选择要留存的文件；查看、比较或另存旧版，不改变当前流程">文件版本</button>
    </span>
    {open && <FileVersionsDialog root={root} path={path} workspaceId={workspaceId} initial={data} initialError={error} onDataChange={setData} onClose={() => setOpen(false)} />}
  </>;
}

function FileVersionsDialog({ root, path, workspaceId, initial, initialError, onDataChange, onClose }: {
  root: string;
  path?: string;
  workspaceId?: string;
  initial: FileVersionsDto | null;
  initialError: string | null;
  onDataChange: (data: FileVersionsDto) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState(initial);
  const [chosen, setChosen] = useState(initial?.files[0]?.path ?? "");
  const [versionId, setVersionId] = useState(initial?.files[0]?.versions[0]?.id ?? "");
  const [compareId, setCompareId] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [otherPreview, setOtherPreview] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"snapshot" | "rename" | "export" | null>(null);
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const file = data?.files.find((candidate) => candidate.path === chosen);
  const version = file?.versions.find((candidate) => candidate.id === versionId);
  const compared = file?.versions.find((candidate) => candidate.id === compareId);
  const kind = projectFilePreviewKind(chosen);
  const lines = useMemo(() => diff && diff.before !== diff.after ? lineDiff(diff.before, diff.after) : [], [diff]);
  async function reload() {
    const next = await invoke<FileVersionsDto>("file_versions", { root, path: path ?? null, workspaceId: workspaceId ?? null });
    setData(next); onDataChange(next);
    const selected = next.files.find((candidate) => candidate.path === chosen) ?? next.files[0];
    setChosen(selected?.path ?? "");
    setVersionId(selected?.versions[0]?.id ?? "");
    setCompareId("");
  }
  useEffect(() => {
    let stale = false;
    setPreview(null); setOtherPreview(null); setDiff(null);
    if (!version || !data) return;
    setError(null);
    const request = compareId && kind !== "image"
      ? invoke<{ before: string; after: string }>("file_version_diff", { root: data.root, from: compareId, to: version.id }).then((result) => { if (!stale) setDiff(result); })
      : Promise.all([
        invoke<string>("file_version_preview", { root: data.root, versionId: version.id }),
        compareId ? invoke<string>("file_version_preview", { root: data.root, versionId: compareId }) : Promise.resolve(null),
      ]).then(([current, other]) => { if (!stale) { setPreview(current); setOtherPreview(other); } });
    request.catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [data?.root, version?.id, compareId, kind]);
  async function update(action: string, note = "") {
    if (!file || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await invoke("file_version_update", { root, path: file.path, action, versionId: version?.id ?? null, note, workspaceId: workspaceId ?? null });
      await reload(); setForm(null);
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
  function choose(next: VersionFile) {
    setChosen(next.path); setVersionId(next.versions[0]?.id ?? ""); setCompareId(""); setForm(null); setError(null); setNotice(null);
  }
  const previewRoot = preview?.replace(/[/\\][^/\\]+$/, "") ?? "";
  return <Modal open size="xl" layer="overlay" title={path ? "历史版本" : "文件版本"} onClose={onClose} dismissOnBackdrop={!busy}
    description="选一次文件，后续保存进项目时有改动才留新版。旧版只读，可另存继续修改，不替换现稿。">
    <div className="flex min-h-[45vh] flex-col gap-3 sm:flex-row">
      {!path && <div className="max-h-44 shrink-0 overflow-auto sm:max-h-[65vh] sm:w-48">
        {data?.files.map((candidate) => <button key={candidate.path} type="button" onClick={() => choose(candidate)} title={candidate.path}
          className={`block w-full truncate rounded-sm px-2 py-1 text-left text-xs ${chosen === candidate.path ? "bg-hover text-l1" : "text-l3 hover:bg-hover"}`}>
          {candidate.path}<span className="ml-2 text-micro text-l4">{candidate.versions.length ? `${candidate.versions.length} 版` : "未留存"}</span>
        </button>)}
      </div>}
      <div className="min-w-0 flex-1 space-y-3">
        {file && <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="min-w-0 break-all text-l2">{file.path}</span>
            <label className="ml-auto inline-flex items-center gap-1.5 text-l3" title="只在你评审保存进项目后留新版，不记录每次敲字；取消不会删除已有版本">
              <input type="checkbox" checked={file.tracked} disabled={busy || (!file.exists && !file.tracked)} onChange={() => void update(file.tracked ? "untrack" : "track")} />保留后续版本
            </label>
            <button type="button" className={LINK} disabled={busy || !file.exists} onClick={() => { setForm("snapshot"); setValue(""); }}>留存当前这一版…</button>
          </div>
          {!file.exists && <p className="text-xs text-l4">当前文件已不存在，已有留存仍可查看和另存。</p>}
          {file.versions.length > 0 ? <div className="flex flex-wrap items-center gap-2 text-xs">
            <select aria-label="查看的版本" className={`${fieldClass} min-w-0 max-w-full flex-1`} value={versionId} onChange={(event) => { setVersionId(event.target.value); setCompareId(""); setForm(null); }}>
              {file.versions.map((item) => <option key={item.id} value={item.id}>{item.note || roundTime(item.savedAt)} · {item.source}</option>)}
            </select>
            {file.versions.length > 1 && (kind === "text" || kind === "image") && <select aria-label="比较的版本" className={`${fieldClass} min-w-0 max-w-full flex-1`} value={compareId} onChange={(event) => setCompareId(event.target.value)}>
              <option value="">不比较</option>
              {file.versions.filter((item) => item.id !== versionId).map((item) => <option key={item.id} value={item.id}>对比：{item.note || roundTime(item.savedAt)}</option>)}
            </select>}
            <button type="button" className={LINK} disabled={busy} onClick={() => { setForm("rename"); setValue(version?.note ?? ""); }}>备注…</button>
            <button type="button" className={LINK} disabled={busy} onClick={() => { setForm("export"); setValue(chosen.replace(/(\.[^/.]+)?$/, "-副本$1")); }}>另存为副本…</button>
            <button type="button" className={LINK} disabled={busy} onClick={() => void remove()}>删除留存…</button>
          </div> : <p className="py-4 text-xs text-l4">还没有留存。勾选「保留后续版本」会先留当前磁盘上的一版；未保存的编辑不在其中。</p>}
          {version && <p className="text-micro text-l4">{roundTime(version.savedAt)} · {version.source}{version.round ? ` · 第 ${version.round} 轮` : ""}{version.cause ? ` · ${roundCauseLabel(version.cause)}` : ""}{version.note ? ` · ${version.note}` : ""}</p>}
          {form && <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <input autoFocus aria-label={form === "export" ? "副本路径" : "版本备注"} className={`${fieldClass} min-w-0 flex-1`} maxLength={form === "export" ? undefined : 200} value={value} onChange={(event) => setValue(event.target.value)} placeholder={form === "export" ? "项目内新文件名，不覆盖已有文件" : "备注（可选），例如导师看过的版本"} />
            <button type="submit" className={secondaryActionClass} disabled={busy || (form === "export" && !value.trim())}>{form === "export" ? "另存" : "保存"}</button>
            <button type="button" className={LINK} disabled={busy} onClick={() => setForm(null)}>取消</button>
          </form>}
        </>}
        {error && <InlineNotice>{error}<button type="button" className={`${LINK} ml-2`} onClick={() => void reload().then(() => setError(null)).catch((reason) => setError(String(reason)))}>重试</button></InlineNotice>}
        {notice && <p role="status" className="break-all text-xs text-l3">{notice}</p>}
        {diff && <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-xs text-l2">
          {diff.before === diff.after ? "两版内容一样。" : lines.map((line, index) => <span key={index} className={`block ${line.op === "+" ? "bg-add/10 text-add" : line.op === "-" ? "bg-del/10 text-del" : ""}`}>{line.op === "~" ? "⋯" : `${line.op} ${line.text}`}</span>)}
        </pre>}
        {preview && <Suspense fallback={<p className="text-xs text-l4">读取中…</p>}>
          <div className={`grid h-[55vh] min-h-0 gap-2 ${otherPreview ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
            {otherPreview && <div className="flex min-h-0 min-w-0 flex-col"><p className="text-xs text-l3">{compared?.note || (compared && roundTime(compared.savedAt))}</p><ProjectFilePreview path={otherPreview} root={otherPreview.replace(/[/\\][^/\\]+$/, "")} readOnly="历史留存只读；要修改请另存为副本" /></div>}
            <ProjectFilePreview path={preview} root={previewRoot} readOnly="历史留存只读；要修改请另存为副本" />
          </div>
        </Suspense>}
        {version && !preview && !diff && !error && <p className="text-xs text-l4">读取中…</p>}
      </div>
    </div>
  </Modal>;
}
