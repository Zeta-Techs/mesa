import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import { fieldClass, primaryActionClass, quietActionClass } from "./PageFrame";
import { moveId, promptLabel, promptPreview } from "../prompts";
import { usePromptStore } from "../prompt-store";

type Editing = { id: string | null; title: string; body: string };

/**
 * 常用提示词的管理弹窗（2026-10-30 用户：「存一些提示词，一段话那种」）：
 * 一页列表（名称 + 正文第一行，↑↓ 排顺序、编辑、删除），编辑就地换成表单。
 * 入口在对话输入框「+」菜单里；用在对话里是「+」点名字或输入框打 / 搜。
 */
export default function PromptManager() {
  const open = usePromptStore((s) => s.manageOpen);
  const draft = usePromptStore((s) => s.draft);
  const items = usePromptStore((s) => s.items);
  const loadError = usePromptStore((s) => s.error);
  const { closeManage, save, remove, reorder } = usePromptStore.getState();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // 打开时：带着输入框里的字进来就直接是新建表单，否则先看列表
  useEffect(() => {
    if (!open) return;
    setError(null);
    setEditing(draft ? { id: null, title: "", body: draft } : null);
  }, [open, draft]);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!editing || !editing.body.trim()) return;
    const ok = await run(() =>
      save({ id: editing.id ?? undefined, title: editing.title, body: editing.body }),
    );
    if (ok) setEditing(null);
  }

  async function onDelete(id: string, label: string) {
    if (!(await confirmDialog(`删除提示词「${label}」？删了找不回来。`, { danger: true, confirmText: "删除" }))) return;
    await run(() => remove(id));
  }

  const ids = items.map((p) => p.id);
  const iconBtn =
    "flex size-7 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-l1 disabled:pointer-events-none disabled:opacity-30";

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) closeManage();
      }}
      size="lg"
      title={editing ? (editing.id ? "编辑提示词" : "新建提示词") : "常用提示词"}
      description={
        editing
          ? "名称可以不填，不填就拿正文第一行当名字。"
          : "存一些常用的话，在对话输入框里点「+」选，或打 / 加名字搜，正文会填进输入框，改完再发。"
      }
      initialFocusRef={editing ? bodyRef : undefined}
      footer={
        editing ? (
          <>
            <button type="button" className={quietActionClass} disabled={busy} onClick={() => setEditing(null)}>
              {items.length > 0 ? "返回列表" : "取消"}
            </button>
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy || !editing.body.trim()}
              onClick={() => void submit()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={quietActionClass} onClick={closeManage}>
              关闭
            </button>
            <button
              type="button"
              className={primaryActionClass}
              onClick={() => setEditing({ id: null, title: "", body: "" })}
            >
              + 新建提示词
            </button>
          </>
        )
      }
    >
      {(error ?? loadError) && <p className="mb-3 text-xs text-err-text">{error ?? loadError}</p>}
      {editing ? (
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-l3">名称（可不填）</span>
            <input
              className={fieldClass}
              value={editing.title}
              maxLength={60}
              placeholder="例：审稿意见逐条回复"
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-l3">正文</span>
            <textarea
              ref={bodyRef}
              className={`${fieldClass} min-h-48 resize-y leading-6`}
              value={editing.body}
              placeholder="要反复用的那段话"
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <p className="text-micro text-l4">⌘ / Ctrl + Enter 保存</p>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg bg-chat-bubble px-4 py-6 text-center text-sm text-l3">
          还没有提示词。点右下「新建提示词」，或者在输入框写好一段，再点「+ → 把输入框存成提示词」。
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((p, i) => {
            const label = promptLabel(p);
            const preview = promptPreview(p);
            return (
              <li
                key={p.id}
                className="group flex items-center gap-2 border-b border-hairline py-2.5 last:border-b-0"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  title="编辑"
                  onClick={() => setEditing({ id: p.id, title: p.title, body: p.body })}
                >
                  <span className="block truncate text-sm font-medium text-l1">{label}</span>
                  {preview && <span className="mt-0.5 block truncate text-xs text-l3">{preview}</span>}
                </button>
                <span className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={`上移 ${label}`}
                    title="上移"
                    disabled={busy || i === 0}
                    onClick={() => void run(() => reorder(moveId(ids, p.id, -1)))}
                  >
                    <ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={`下移 ${label}`}
                    title="下移"
                    disabled={busy || i === items.length - 1}
                    onClick={() => void run(() => reorder(moveId(ids, p.id, 1)))}
                  >
                    <ArrowDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={`编辑 ${label}`}
                    title="编辑"
                    disabled={busy}
                    onClick={() => setEditing({ id: p.id, title: p.title, body: p.body })}
                  >
                    <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`${iconBtn} hover:text-err-text`}
                    aria-label={`删除 ${label}`}
                    title="删除"
                    disabled={busy}
                    onClick={() => void onDelete(p.id, label)}
                  >
                    <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!editing && items.length > 0 && (
        <p className="mt-3 text-micro text-l4">
          存在本机，换项目、换 Agent 都能用；不会写进任何 Agent 的配置。
        </p>
      )}
    </Modal>
  );
}
