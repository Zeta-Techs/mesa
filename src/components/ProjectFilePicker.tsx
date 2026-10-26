import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, LayoutGrid, List, Search } from "lucide-react";
import { Modal } from "./Modal";
import { primaryActionClass, quietActionClass } from "./PageFrame";
import type { SearchResultDto } from "./FileTree";
import { isPreviewableImagePath } from "../file-icons";
import { FileTypeGlyph } from "./FileTypeMark";
import { fileThumb, hasFileThumb } from "../file-thumb";
import { fileDateLabel, filesOnly, folderOf, toggleSelected, type PickFile } from "../project-file-pick";

/**
 * 「＋ → 引用项目文件」弹层（2026-10-26 用户：点了只插个 @、选不了文件，要做成点开就能挑的样子）：
 * 顶上搜索，下面是这个项目最近改过的文件（list_recent_files），每次打开是列表（同日用户：默认用列表），
 * 每行左边带缩略图；右上角换网格看大缩略图（图片、PDF、Word、表格、文字都画，file-thumb.ts；画不出的 PPT 等给 FileTypeGlyph 线条图标 + 类型色）；
 * 点行勾选（可多选），「添加」后成输入框里的附件卡，随消息按路径发出（同「文件或图片」）
 */
export default function ProjectFilePicker({
  open,
  cwd,
  onClose,
  onAdd,
}: {
  open: boolean;
  cwd: string;
  onClose: () => void;
  onAdd: (paths: string[]) => void;
}) {
  const [recent, setRecent] = useState<PickFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PickFile[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [view, setView] = useState<"list" | "grid">("list");
  const listRef = useRef<HTMLDivElement>(null);

  // 每次打开重新列：刚让 AI 出的图、刚存的稿子要在最上面
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setView("list");
    setHits(null);
    setSelected([]);
    setActive(0);
    setError(null);
    setRecent(null);
    let stale = false;
    invoke<{ path: string; name: string; rel: string; modified: string | null }[]>("list_recent_files", { root: cwd })
      .then((files) => {
        if (!stale) setRecent(files.map((f) => ({ ...f, rel: f.rel.replace(/\\/g, "/") })));
      })
      .catch((reason) => {
        if (!stale) setError(`列不出这个文件夹里的文件：${String(reason)}`);
      });
    return () => {
      stale = true;
    };
  }, [open, cwd]);

  // 搜索：打字停 150ms 再搜整个项目（同 @ 引用的 search_files），只留文件
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", { root: cwd, query: q, showHidden: false })
        .then((found) => {
          if (!stale) {
            setHits(filesOnly(found));
            setActive(0);
          }
        })
        .catch(() => {
          if (!stale) setHits([]);
        });
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [query, open, cwd]);

  const rows = query.trim() ? hits : recent;
  const activeIdx = rows && rows.length > 0 ? Math.min(active, rows.length - 1) : -1;

  useEffect(() => {
    if (activeIdx < 0) return;
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx]);

  function toggle(path: string) {
    setSelected((cur) => toggleSelected(cur, path));
  }
  function add(paths: string[]) {
    if (paths.length === 0) return;
    onAdd(paths);
    onClose();
  }

  const status =
    error ??
    (rows === null
      ? query.trim()
        ? "正在找…"
        : "正在列文件…"
      : rows.length === 0
        ? query.trim()
          ? `没找到「${query.trim()}」`
          : "这个文件夹里还没有文件"
        : null);

  return (
    <Modal
      open={open}
      title="引用项目文件"
      onClose={onClose}
      size="lg"
      overflow="hidden"
      contentClassName="flex min-h-0 flex-1 flex-col"
      footer={
        <>
          {selected.length > 0 && (
            <span className="mr-auto text-xs text-l3">
              已选 {selected.length} 个
              <button type="button" className="ml-2 text-l4 hover:text-l1" onClick={() => setSelected([])}>
                清空
              </button>
            </span>
          )}
          <button type="button" className={quietActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={selected.length === 0}
            onClick={() => add(selected)}
          >
            {selected.length > 1 ? `添加 ${selected.length} 个` : "添加"}
          </button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-inset px-3 transition-colors focus-within:bg-raised">
          <Search size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (!rows || rows.length === 0) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setActive((activeIdx + delta + rows.length) % rows.length);
                return;
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                add(selected.length > 0 ? selected : [rows[activeIdx].path]);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                toggle(rows[activeIdx].path);
              }
            }}
            placeholder="搜索项目文件（文件名的一部分，或 pdf、png 这样的后缀）"
            aria-label="搜索项目文件"
            className="ccode-picker-search min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l3"
          />
        </label>
        <button
          type="button"
          onClick={() => setView(view === "list" ? "grid" : "list")}
          title={view === "list" ? "换成网格（看图方便）" : "换成列表"}
          aria-label={view === "list" ? "网格显示" : "列表显示"}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-l3 transition-colors hover:bg-hover hover:text-l1"
        >
          {view === "list" ? (
            <LayoutGrid size={16} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <List size={16} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      </div>
      <p className="mt-2 shrink-0 text-micro text-l4">
        {query.trim() ? "在整个项目里找" : "最近改过的在前"} · 点一下勾选，可以选好几个 · 双击直接添加
      </p>
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label="项目文件"
        className="ccode-rail-scroll mt-2 h-[min(56vh,30rem)] overflow-y-auto"
      >
        {status ? (
          <p className="px-2 py-8 text-center text-xs text-l3">{status}</p>
        ) : view === "list" ? (
          rows!.map((f, i) => (
            <FileRow
              key={f.path}
              file={f}
              idx={i}
              cwd={cwd}
              active={i === activeIdx}
              checked={selected.includes(f.path)}
              onToggle={() => toggle(f.path)}
              onAdd={() => add([f.path])}
              onHover={() => setActive(i)}
            />
          ))
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2 p-0.5">
            {rows!.map((f, i) => (
              <FileTile
                key={f.path}
                file={f}
                idx={i}
                cwd={cwd}
                active={i === activeIdx}
                checked={selected.includes(f.path)}
                onToggle={() => toggle(f.path)}
                onAdd={() => add([f.path])}
                onHover={() => setActive(i)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

type ItemProps = {
  file: PickFile;
  idx: number;
  cwd: string;
  active: boolean;
  checked: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onHover: () => void;
};

/** 右边的勾选圈：没勾时只在悬停 / 键盘停在这行时露出空圈，勾上是实心带勾 */
function CheckMark({ checked, active, onImage = false }: { checked: boolean; active: boolean; onImage?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-opacity ${
        checked
          ? "border-cta-bd bg-cta text-cta-text"
          : `border-l4 ${onImage ? "bg-canvas/60" : ""} ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
      }`}
    >
      {checked && <Check size={12} strokeWidth={2.6} />}
    </span>
  );
}

/** 缩略图：滚到看得见才画（file-thumb.ts：图片读原图，PDF / Word / 表格 / 文字排成一页纸），画不出就给 FileTypeGlyph 线条图标 + 类型色 */
function useFileThumb(file: PickFile, cwd: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const can = hasFileThumb(file.path);
  useEffect(() => {
    setUrl(null);
    if (!can) return;
    let stale = false;
    const load = () =>
      void fileThumb(file.path, cwd, file.modified).then((u) => {
        if (!stale) setUrl(u);
      });
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        stale = true;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        load();
      }
    });
    io.observe(el);
    return () => {
      stale = true;
      io.disconnect();
    };
  }, [file.path, file.modified, cwd, can]);
  // 文档是一页纸：从纸顶往下看；图片居中裁
  const fit = isPreviewableImagePath(file.path) ? "object-cover" : "object-cover object-top bg-white";
  return { ref, url, fit };
}

/** 没有缩略图时的类型图标（同文件列表的线条图标 + 识别色，不铺色块） */
function KindBlock({ path, big = false }: { path: string; big?: boolean }) {
  return (
    <span className="flex h-full w-full items-center justify-center">
      <FileTypeGlyph path={path} size={big ? 26 : 16} />
    </span>
  );
}

function FileRow({ file, idx, cwd, active, checked, onToggle, onAdd, onHover }: ItemProps) {
  const { ref, url, fit } = useFileThumb(file, cwd);
  const folder = folderOf(file.rel);
  const date = fileDateLabel(file.modified);
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      data-idx={idx}
      title={file.rel}
      onClick={onToggle}
      onDoubleClick={onAdd}
      onMouseMove={onHover}
      className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
        active || checked ? "bg-hover" : ""
      }`}
    >
      <span
        ref={ref}
        className="size-9 shrink-0 overflow-hidden rounded-md border border-hairline bg-canvas"
      >
        {url ? <img src={url} alt="" className={`h-full w-full ${fit}`} /> : <KindBlock path={file.path} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-l1">{file.name}</span>
        <span className="truncate text-xs text-l3">
          {date}
          {folder && <span className="text-l4">{date ? " · " : ""}{folder}</span>}
        </span>
      </span>
      <CheckMark checked={checked} active={active} />
    </button>
  );
}

function FileTile({ file, idx, cwd, active, checked, onToggle, onAdd, onHover }: ItemProps) {
  const { ref, url, fit } = useFileThumb(file, cwd);
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      data-idx={idx}
      title={file.rel}
      onClick={onToggle}
      onDoubleClick={onAdd}
      onMouseMove={onHover}
      className={`group relative flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-colors ${
        active || checked ? "bg-hover" : ""
      }`}
    >
      <span ref={ref} className="block aspect-[4/3] w-full overflow-hidden rounded-md border border-hairline bg-canvas">
        {url ? <img src={url} alt="" className={`h-full w-full ${fit}`} /> : <KindBlock path={file.path} big />}
      </span>
      <span className="truncate px-0.5 text-xs text-l1">{file.name}</span>
      <span className="absolute right-2.5 top-2.5">
        <CheckMark checked={checked} active={active} onImage />
      </span>
    </button>
  );
}
