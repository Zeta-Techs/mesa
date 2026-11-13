import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { fieldClass, InlineNotice, secondaryActionClass } from "./PageFrame";
import { projectFilePreviewKind } from "../project-files";
import { showProjectFile } from "../project-file-open";
import { roundCauseLabel, roundTime } from "../step-loop";
import type { FileVersionsDto, VersionFile, VersionComparison } from "../types";
import { FileSelectionTree } from "./FileTree";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const ProjectFilePreview = lazy(() => import("./ProjectFilePreview"));
const TextVersionCompare = lazy(() => import("./TextVersionCompare"));
const ImageVersionCompare = lazy(() => import("./ImageVersionCompare"));
const LINK = "shrink-0 rounded-sm text-xs text-l3 underline-offset-2 hover:text-l1 hover:underline disabled:opacity-40";
const absolute = (root: string, path: string) => `${root.replace(/[/\\]+$/, "")}/${path}`;

export function FileVersionsButton({ root, path, workspaceId, refreshKey = "", lead, onOpen, className = LINK }: {
  root: string;
  path?: string;
  workspaceId?: string;
  refreshKey?: string;
  lead?: ReactNode;
  onOpen?: () => void | Promise<void>;
  /** 步骤卡回头组传描边按钮样式；预览栏等处默认文字链接 */
  className?: string;
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
  return <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
    {lead}
    <button type="button" className={className} onClick={() => void open()} title={error ?? "在右侧文件栏查看现稿和历史；留存只决定以后保存哪些版本"}>文件版本</button>
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
  const [comparison, setComparison] = useState<VersionComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"snapshot" | "rename" | null>(null);
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [treeOpen, setTreeOpen] = useState(!path);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [compareRefresh, setCompareRefresh] = useState(0);
  const menuButton = useRef<HTMLButtonElement>(null);
  const paths = useMemo(() => data?.files.map((file) => file.path) ?? [], [data]);
  const version = file?.versions.find((candidate) => candidate.id === versionId);
  const compared = file?.versions.find((candidate) => candidate.id === compareId);
  const kind = projectFilePreviewKind(chosen);
  const retained = !!version && !version.id.startsWith("git:");
  const compareLabel = compared ? compared.note || roundTime(compared.savedAt) : "当前文件（磁盘已保存）";
  useEffect(() => setMenu(null), [chosen, versionId]);
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
    setFile(null); setPreview(null); setComparison(null); setCompareId("");
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
    setPreview(null); setComparison(null);
    if (!file || !data) return;
    setError(null);
    if (!versionId) {
      if (file.exists) setPreview(path ?? absolute(root, chosen));
      return;
    }
    if (!version) return;
    const request = compareId
      ? invoke<VersionComparison>("file_version_compare", { root, from: version.id, to: compareId === "current" ? null : compareId, image: kind === "image" }).then((result) => { if (!stale) setComparison(result); })
      : invoke<string>("file_version_preview", { root: data.root, versionId: version.id }).then((current) => { if (!stale) setPreview(current); });
    request.catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [file, data?.root, chosen, path, root, versionId, compareId, kind, compareRefresh]);
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
    await update(form ?? "snapshot", value);
  }
  async function exportVersion() {
    if (!version || !data) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const target = await invoke<string | null>("file_version_export", { root: data.root, versionId: version.id });
      if (target) setNotice(`已另存：${target}。当前文件未替换。`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function openForm(next: "snapshot" | "rename") {
    setForm(next);
    setValue(next === "rename" ? version?.note ?? "" : "");
  }
  const menuItems: ContextMenuItem[] = file ? [
    {
      label: "保留后续版本",
      checked: file.tracked,
      disabled: busy || (!file.exists && !file.tracked),
      title: "只决定以后留哪些版本，不影响查看已有历史；取消不删除已留存版本",
      onSelect: () => void update(file.tracked ? "untrack" : "track"),
    },
    { label: "留存当前这一版…", disabled: busy || !file.exists, onSelect: () => openForm("snapshot") },
    ...(retained ? [
      { label: "备注…", disabled: busy, onSelect: () => openForm("rename") },
      { label: "删除留存…", danger: true, disabled: busy, onSelect: () => void remove() },
    ] : []),
  ] : [];
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
    <div className="shrink-0 space-y-2 px-2">
      {file && <>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="查看的版本" className={`${fieldClass} h-7 min-w-0 flex-1`} value={versionId} onChange={(event) => { const next = event.target.value; setVersionId(next); setCompareId((current) => !next || current === next ? "" : current); setForm(null); }}>
            {file.exists && <option value="">当前文件</option>}
            {file.versions.map((item) => <option key={item.id} value={item.id}>{item.note || roundTime(item.savedAt)} · {item.source}</option>)}
          </select>
          {version && <button type="button" className={`${LINK} h-7 px-1 text-l2`} disabled={busy} onClick={() => void exportVersion()}>另存为副本…</button>}
          <button ref={menuButton} type="button" className={`${LINK} h-7 px-1`} aria-haspopup="menu" aria-expanded={!!menu} disabled={busy} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu((current) => current ? null : { x: rect.right, y: rect.bottom });
          }}>更多</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-micro text-l3">
          <span title={versionId ? "历史版本只读；要修改请另存为副本" : "当前文件仅预览；返回文件后继续编辑"}>
            {version ? `${version.source}${version.round ? ` · 第 ${version.round} 轮` : ""}${version.cause ? ` · ${roundCauseLabel(version.cause)}` : ""} · 只读` : "仅预览"}
          </span>
          {version && (kind === "text" || kind === "image") && <>
            {file.exists && !compareId && <button type="button" className={`${LINK} text-l2`} onClick={() => setCompareId("current")}>和现稿比较</button>}
            {(compareId || file.versions.length > 1) && <select aria-label="比较的版本" className={`${fieldClass} min-w-0 max-w-full`} value={compareId} onChange={(event) => setCompareId(event.target.value)}>
            <option value="">选择其他版本比较…</option>
            {file.exists && <option value="current">当前文件（磁盘已保存）</option>}
            {file.versions.filter((item) => item.id !== versionId).map((item) => <option key={item.id} value={item.id}>对比：{item.note || roundTime(item.savedAt)}</option>)}
            </select>}
            {compareId && <button type="button" className={LINK} onClick={() => setCompareId("")}>结束比较</button>}
            {compareId === "current" && <button type="button" className={LINK} onClick={() => setCompareRefresh((current) => current + 1)}>刷新对照</button>}
          </>}
        </div>
        {!file.exists && !file.versions.length && <p className="py-2 text-xs text-l4">当前路径没有文件，也没有可读取的历史；留存不能找回已清理的内容。</p>}
        {form && <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input autoFocus aria-label="版本备注" className={`${fieldClass} min-w-0 flex-1`} maxLength={200} value={value} onChange={(event) => setValue(event.target.value)} placeholder="备注（可选）" />
          <button type="submit" className={secondaryActionClass} disabled={busy}>保存</button>
          <button type="button" className={LINK} disabled={busy} onClick={() => setForm(null)}>取消</button>
        </form>}
      </>}
      {error && <InlineNotice>{error}<button type="button" className={`${LINK} ml-2`} onClick={() => setRevision((current) => current + 1)}>重试</button></InlineNotice>}
      {notice && <p role="status" className="break-all text-xs text-l3">{notice}</p>}
      {!file && !error && <p className="text-xs text-l4">读取中…</p>}
    </div>
    {compareId && version && <div className="grid shrink-0 grid-cols-2 gap-2 px-2 text-xs text-l3"><span>左：{version.note || roundTime(version.savedAt)}</span><span>右：{compareLabel}</span></div>}
    {comparison && <Suspense fallback={<p className="px-2 text-xs text-l3">读取对照…</p>}>
      {comparison.beforePath && comparison.afterPath ? <ImageVersionCompare before={comparison.beforePath} after={comparison.afterPath} /> : comparison.before !== null && comparison.after !== null ? <TextVersionCompare before={comparison.before} after={comparison.after} /> : null}
    </Suspense>}
    {preview && <Suspense fallback={<p className="text-xs text-l4">读取中…</p>}>
      <div className="flex min-h-0 flex-1 flex-col">
        <ProjectFilePreview key={preview} path={preview} root={versionId ? preview.replace(/[/\\][^/\\]+$/, "") : root} readOnly={versionId ? "历史版本只读；要修改请另存为副本" : "版本查看只读；返回文件后继续编辑"} hideReadOnlyToolbar />
      </div>
    </Suspense>}
    {compareId && !comparison && !error && <p className="px-2 text-xs text-l3">读取对照…</p>}
      </div>
    </div>
    {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} alignRight items={menuItems} onClose={() => { setMenu(null); menuButton.current?.focus(); }} />, document.body)}
  </section>;
}
