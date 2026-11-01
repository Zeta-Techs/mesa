import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { Modal } from "./Modal";
import { InlineNotice, primaryActionClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { MONACO_THEME, monacoThemeData } from "../themes";
import { toast } from "../toast";
import { dirtyTags, fileHint, formatJsonText, type ConfigFileDto } from "../config-file-editor";

// 文件预览加载过就已设好；连接页单独打开这个弹层时没人设，自己补上（只用基础 worker，语言服务不开）
if (!self.MonacoEnvironment) {
  self.MonacoEnvironment = { getWorker: () => new editorWorker() };
}

/** 主题跟随当前 data-theme：打开时按 CSS 令牌重新定义一次（与文件预览同一个主题名） */
function syncTheme() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  monaco.editor.defineTheme(MONACO_THEME, monacoThemeData(root.dataset.theme, (n) => cs.getPropertyValue(n)));
}

/**
 * 连接页「编辑配置文件」（docs/design-config-file-editor.md）：一家 Agent 的全局配置文件逐个页签编辑。
 * 内容里的密钥由后端换成「已隐藏密钥」占位，前端拿不到原值；保存经后端还原、校验、备份后写入。
 */
export default function ConfigFileEditorDialog({
  agentId,
  agentLabel,
  initialTag,
  onClose,
}: {
  agentId: string;
  /** 打开即定位到这个文件（编辑连接「配置」视图的「打开文件」入口） */
  initialTag?: string;
  agentLabel: string;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<ConfigFileDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());

  useEffect(() => {
    let alive = true;
    invoke<ConfigFileDto[]>("config_files_read", { agent: agentId })
      .then((list) => {
        if (!alive) return;
        // 先定好页签再放文件：建编辑器时用的就是要定位的那个文件
        const at = initialTag ? list.findIndex((f) => f.tag === initialTag) : -1;
        setActive(at >= 0 ? at : 0);
        setFiles(list);
        setValues(Object.fromEntries(list.map((f) => [f.tag, f.content])));
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
    };
  }, [agentId]);

  // 文件读到后建编辑器；每个文件一个 model（切页签保留各自的撤销历史）
  useEffect(() => {
    const host = hostRef.current;
    if (!files || files.length === 0 || !host) return;
    syncTheme();
    const models = modelsRef.current;
    for (const f of files) {
      const model = monaco.editor.createModel(f.content, f.language);
      model.onDidChangeContent(() => setValues((v) => ({ ...v, [f.tag]: model.getValue() })));
      models.set(f.tag, model);
    }
    const editor = monaco.editor.create(host, {
      model: models.get(files[active]?.tag ?? files[0].tag) ?? null,
      theme: MONACO_THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      readOnly: !!(files[active] ?? files[0]).error,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      for (const m of models.values()) m.dispose();
      models.clear();
      editorRef.current = null;
    };
    // 只在第一次读到文件时建；保存后的刷新只改对应 model 的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files === null]);

  const current = files?.[active] ?? null;

  const switchTo = (i: number) => {
    if (!files) return;
    setActive(i);
    setNotice(null);
    const editor = editorRef.current;
    const model = modelsRef.current.get(files[i].tag);
    if (editor && model) {
      editor.setModel(model);
      editor.updateOptions({ readOnly: !!files[i].error });
    }
  };

  const close = async () => {
    if (files && dirtyTags(files, values).length > 0) {
      const ok = await confirmDialog("有没保存的改动，关掉就丢了。确定关掉吗？", { danger: true, confirmText: "丢掉改动" });
      if (!ok) return;
    }
    onClose();
  };

  const format = () => {
    if (!current) return;
    const model = modelsRef.current.get(current.tag);
    if (!model) return;
    const r = formatJsonText(model.getValue());
    if (r.ok) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.text }], () => null);
      setNotice(null);
    } else {
      setNotice(r.error);
    }
  };

  const save = async () => {
    if (!current || busy) return;
    const model = modelsRef.current.get(current.tag);
    if (!model) return;
    setBusy(true);
    setNotice(null);
    try {
      const path = await invoke<string | null>("config_file_save", {
        agent: agentId,
        tag: current.tag,
        content: model.getValue(),
        revision: current.revision,
      });
      // 按磁盘现状刷新这一页（新的版本号；密钥照旧是占位）
      const fresh = await invoke<ConfigFileDto[]>("config_files_read", { agent: agentId });
      const updated = fresh.find((f) => f.tag === current.tag);
      if (updated) {
        setFiles((list) => list?.map((f) => (f.tag === updated.tag ? updated : f)) ?? list);
        if (model.getValue() !== updated.content) model.setValue(updated.content);
        setValues((v) => ({ ...v, [updated.tag]: updated.content }));
      }
      toast(path ? `已保存 ${path}（已备份，可撤销）` : "没有改动，没写文件");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!current && values[current.tag] !== undefined && values[current.tag] !== current.content;

  return (
    <Modal
      open
      title={`编辑配置文件 · ${agentLabel}`}
      description={
        initialTag
          ? "这是文件原样，里面是现在全局生效的配置，不一定是你在编辑的那条连接；连接之外的设置在这里改。"
          : "这家 Agent 自己读的全局配置；设为全局默认写的也是这几个文件。"
      }
      onClose={() => void close()}
      size="xl"
      overflow="hidden"
      dismissOnBackdrop={false}
      footer={
        <>
          {current?.language === "json" && !current.error && (
            <button type="button" onClick={format} className={`${secondaryActionClass} mr-auto`}>
              格式化
            </button>
          )}
          <button type="button" onClick={() => void close()} className={secondaryActionClass}>
            取消
          </button>
          <button
            type="button"
            disabled={busy || !current || !!current.error || !dirty}
            onClick={() => void save()}
            className={primaryActionClass}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <div className="flex h-[min(70vh,640px)] flex-col gap-2 px-4 py-3 text-xs">
        {loadError && <InlineNotice tone="err">{loadError}</InlineNotice>}
        {!files && !loadError && <p className="text-l3">◌ 正在读取…</p>}
        {files && files.length === 0 && <p className="text-l3">这家 Agent 没有可在这里编辑的配置文件。</p>}
        {files && files.length > 1 && (
          <div role="tablist" className="flex gap-1 border-b border-hairline">
            {files.map((f, i) => {
              const changed = values[f.tag] !== undefined && values[f.tag] !== f.content;
              return (
                <button
                  key={f.tag}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  onClick={() => switchTo(i)}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 ${
                    i === active ? "border-cta font-medium text-l1" : "border-transparent text-l3 hover:text-l2"
                  }`}
                >
                  {f.tag}
                  {changed && <span className="ml-1 text-warn-text">●</span>}
                </button>
              );
            })}
          </div>
        )}
        {current && <p className="break-all font-mono text-micro text-l3">{current.path}</p>}
        <div
          ref={hostRef}
          className={`min-h-0 flex-1 overflow-hidden rounded-md border border-hairline ${files?.length ? "" : "hidden"}`}
        />
        {notice && <InlineNotice tone="err">{notice}</InlineNotice>}
        {current && <p className="text-micro leading-5 text-l3">{fileHint(current)}</p>}
      </div>
    </Modal>
  );
}
