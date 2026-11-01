import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { MONACO_THEME, monacoThemeData } from "../themes";

// 文件预览加载过就已设好；单独用到这个输入框时没人设，自己补上（只用基础 worker，语言服务不开）
if (!self.MonacoEnvironment) {
  self.MonacoEnvironment = { getWorker: () => new editorWorker() };
}

/**
 * 表单里的一块代码输入框（编辑连接弹层的「配置」视图用）：受控文本，外部换值时同步进编辑器。
 * 主题打开时按当前 data-theme 的 CSS 令牌定义一次（与文件预览同一个主题名）。
 */
export default function MonacoField({
  value,
  language,
  onChange,
  ariaLabel,
}: {
  value: string;
  language: string;
  onChange: (text: string) => void;
  ariaLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    monaco.editor.defineTheme(MONACO_THEME, monacoThemeData(root.dataset.theme, (n) => cs.getPropertyValue(n)));
    const editor = monaco.editor.create(host, {
      value,
      language,
      theme: MONACO_THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      ariaLabel,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    });
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    editorRef.current = editor;
    return () => {
      sub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // 只建一次；换值 / 换语言走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  return <div ref={hostRef} className="h-full w-full" />;
}
