import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { MONACO_THEME } from "../themes";

/**
 * 保存撞车时的对比合并（2026-10-26：原先只报一句「请先保留本次编辑，再重新打开文件对比合并」，界面上却没有对比的地方）。
 * 左边磁盘上的版本（只读），右边你的版本（可改；行间箭头把左边那一块搬过来）。
 * 「保存右边的内容」以磁盘那一版为基线保存——保存时磁盘又变了，左边换成最新的、提示再看一眼。
 */
export default function MergeConflictView({
  fileName,
  language,
  disk,
  mine,
  fontSize,
  wordWrap,
  onSave,
  onTakeDisk,
  onClose,
}: {
  fileName: string;
  language: string | undefined;
  /** 磁盘上的版本：变了就刷新左边（右边你的改动不动） */
  disk: string;
  /** 你的版本：只在打开时取一次 */
  mine: string;
  fontSize: number;
  wordWrap: boolean;
  /** 返回 null 表示已保存（宿主会关掉本界面），否则为要显示的提示 */
  onSave: (merged: string) => Promise<string | null>;
  onTakeDisk: () => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const original = monaco.editor.createModel(disk, language);
    const modified = monaco.editor.createModel(mine, language);
    originalRef.current = original;
    modifiedRef.current = modified;
    const diff = monaco.editor.createDiffEditor(host, {
      theme: MONACO_THEME,
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: false,
      renderMarginRevertIcon: true,
      ignoreTrimWhitespace: false,
      wordWrap: wordWrap ? "on" : "off",
      minimap: { enabled: false },
      fontSize,
      scrollBeyondLastLine: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    });
    diff.setModel({ original, modified });
    diffRef.current = diff;
    const sub = diff.onDidUpdateDiff(() => setChanges(diff.getLineChanges()?.length ?? 0));
    return () => {
      sub.dispose();
      diff.dispose();
      original.dispose();
      modified.dispose();
      diffRef.current = null;
    };
    // 只在打开时建一次；磁盘版本变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const original = originalRef.current;
    if (original && original.getValue() !== disk) original.setValue(disk);
  }, [disk]);

  useEffect(() => {
    diffRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Esc 关掉（回到编辑器，修改都还在）；⌘S 保存右边
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  async function save() {
    const merged = modifiedRef.current?.getValue();
    if (merged === undefined || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    try {
      const err = await onSave(merged);
      if (err) setHint(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-label={`对比合并 ${fileName}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-strip px-3 py-2 text-xs">
        <span className="truncate text-sm text-l1">{fileName}</span>
        <span className="text-l4">
          磁盘上的版本被改过 · 左：磁盘上的（只读） · 右：你的（可改，点行间箭头把左边那块搬过来）
          {changes > 0 ? ` · ${changes} 处不同` : ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存右边的内容"}
          </button>
          <button onClick={onTakeDisk} className="rounded-sm px-2 py-1 text-l2 hover:bg-hover">
            用磁盘上的版本
          </button>
          <button onClick={onClose} className="rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1" title="回到编辑器，你的修改都还在（Esc）">
            先回去
          </button>
        </span>
      </div>
      {hint && <p className="shrink-0 bg-inset px-3 py-1 text-xs text-warn-text">{hint}</p>}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
