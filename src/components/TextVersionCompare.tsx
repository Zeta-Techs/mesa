import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { MONACO_THEME, monacoThemeData } from "../themes";
import { readEditorFont } from "../editor-font";
import { foldUnchanged, lineDiff } from "../tool-activity";
import { pairIntraline } from "../diff-intraline";

/** 逐行配对的格数上限（一维 Int32Array，约 16 MB） */
export const COMPARE_MAX_CELLS = 4_000_000;

export default function TextVersionCompare({ before, after }: { before: string; after: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [mode, setMode] = useState<"inline" | "side">("inline");
  // 默认摊开全文；「只看改动」时只留改动行、相隔的未改段落折成 ⋯。中段太大（几千行对几千行）时逐行配对放不下，
  // 退成整段删 + 整段加，并提示改用左右对照（Monaco 自己的差异算法顶得住）
  const { lines, coarse } = useMemo(() => {
    let coarse = false;
    const full = lineDiff(before, after, { context: Infinity, maxCells: COMPARE_MAX_CELLS, onCoarse: () => { coarse = true; } });
    return { lines: onlyChanges ? foldUnchanged(full, 0) : full, coarse };
  }, [before, after, onlyChanges]);
  const ranges = useMemo(() => pairIntraline(lines.map((line) => line.op + line.text)), [lines]);
  const hasChanges = lines.some((line) => line.op === "+" || line.op === "-");
  useEffect(() => {
    if (mode !== "side") return;
    const host = hostRef.current;
    if (!host) return;
    const syncTheme = () => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      monaco.editor.defineTheme(MONACO_THEME, monacoThemeData(root.dataset.theme, (name) => styles.getPropertyValue(name)));
      monaco.editor.setTheme(MONACO_THEME);
    };
    if (!window.MonacoEnvironment) window.MonacoEnvironment = { getWorker: () => new editorWorker() };
    syncTheme();
    const original = monaco.editor.createModel(before, "plaintext");
    const modified = monaco.editor.createModel(after, "plaintext");
    const editor = monaco.editor.createDiffEditor(host, {
      theme: MONACO_THEME, automaticLayout: true, readOnly: true, originalEditable: false,
      renderSideBySide: host.clientWidth >= 640, useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 640, renderMarginRevertIcon: false,
      ignoreTrimWhitespace: false, wordWrap: "on", minimap: { enabled: false },
      fontSize: readEditorFont(), scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: false },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    const observer = new ResizeObserver(() => editor.updateOptions({ renderSideBySide: host.clientWidth >= 640 }));
    observer.observe(host);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => {
      observer.disconnect(); themeObserver.disconnect(); editor.dispose(); original.dispose(); modified.dispose(); editorRef.current = null;
    };
  }, [before, after, mode]);
  useEffect(() => editorRef.current?.updateOptions({ hideUnchangedRegions: { enabled: onlyChanges } }), [onlyChanges, before, after, mode]);
  return <div className="flex min-h-0 flex-1 flex-col gap-1">
    <div className="flex shrink-0 flex-wrap items-center gap-3 px-2 text-xs text-l3">
      <div role="group" aria-label="文本比较方式" className="inline-flex items-center gap-1">
        <button type="button" aria-pressed={mode === "inline"} className={`h-7 rounded-sm px-2 hover:bg-hover ${mode === "inline" ? "bg-hover text-l1" : ""}`} onClick={() => setMode("inline")}>增删对照</button>
        <button type="button" aria-pressed={mode === "side"} className={`h-7 rounded-sm px-2 hover:bg-hover ${mode === "side" ? "bg-hover text-l1" : ""}`} onClick={() => setMode("side")}>左右对照</button>
      </div>
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />只看改动</label>
      <span><span className="text-diff-del-fg">− 删除</span> · <span className="text-diff-add-fg">+ 新增</span></span>
      {!hasChanges && <span role="status">{before === after ? "两版内容一样。" : "仅文件末尾换行不同。"}</span>}
      {mode === "inline" && coarse && <span role="status">改动太多，这里只能整段对照；逐行看请切到「左右对照」。</span>}
    </div>
    {mode === "side" ? <div ref={hostRef} aria-label="文本版本对照（只读）" className="min-h-0 flex-1" /> : <pre aria-label="文本增删对照（只读）" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-xs text-l2">
      {hasChanges && lines.map((line, index) => {
        const range = ranges.get(index);
        return <span key={index} className={`block ${line.op === "+" ? "bg-diff-add-bg text-diff-add-fg" : line.op === "-" ? "bg-diff-del-bg text-diff-del-fg" : "text-l3"}`}>
          {line.op === "~" ? "⋯" : <>{line.op} {range ? <>{line.text.slice(0, range[0])}<strong className="font-semibold underline">{line.text.slice(...range)}</strong>{line.text.slice(range[1])}</> : line.text || " "}</>}
        </span>;
      })}
    </pre>}
  </div>;
}
