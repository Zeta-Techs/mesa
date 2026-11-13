import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { MONACO_THEME, monacoThemeData } from "../themes";
import { readEditorFont } from "../editor-font";

export default function TextVersionCompare({ before, after }: { before: string; after: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  useEffect(() => {
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
  }, [before, after]);
  useEffect(() => editorRef.current?.updateOptions({ hideUnchangedRegions: { enabled: onlyChanges } }), [onlyChanges, before, after]);
  return <div className="flex min-h-0 flex-1 flex-col gap-1">
    <div className="flex shrink-0 items-center gap-3 px-2 text-xs text-l3">
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />只看改动</label>
      <span>宽栏左右对照，窄栏单栏增删</span>
      {before === after && <span role="status">两版内容一样。</span>}
    </div>
    <div ref={hostRef} aria-label="文本版本对照（只读）" className="min-h-0 flex-1" />
  </div>;
}
