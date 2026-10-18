import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import {
  fieldClass,
  primaryActionClass,
  secondaryActionClass,
  NoticeBar,
} from "./PageFrame";

/** 重命名项目弹窗（侧栏项目树右键「重命名项目」）：register_project 是幂等 upsert，同名改不改都行 */
export default function RenameProjectModal({
  path,
  initialName,
  onClose,
  onRenamed,
}: {
  path: string;
  initialName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("register_project", { path, name: name.trim() });
      onRenamed();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="重命名项目" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <h2 className="sr-only">重命名项目</h2>
        <p className="mb-3 truncate font-mono text-xs text-l3" title={path}>
          {path}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">项目名</span>
          <input
            className={fieldClass}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {error && <NoticeBar tone="err" className="mb-3">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={primaryActionClass}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
