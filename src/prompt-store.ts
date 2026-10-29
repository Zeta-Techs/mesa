/**
 * 常用提示词的界面状态：全应用一份（几个对话输入框共用），第一次用到时从后端读一次，
 * 增删改排都走后端再整份替换，避免各输入框手里的列表不一致。管理弹窗由 App 挂一个。
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { PromptItem } from "./prompts";

interface PromptState {
  items: PromptItem[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  manageOpen: boolean;
  /** 打开管理弹窗时直接进入新建（带上输入框里现有的字，方便「把这段存成提示词」） */
  draft: string | null;
  ensureLoaded: () => Promise<void>;
  reload: () => Promise<void>;
  save: (input: { id?: string; title: string; body: string }) => Promise<PromptItem>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  openManage: (draft?: string | null) => void;
  closeManage: () => void;
}

export const usePromptStore = create<PromptState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  manageOpen: false,
  draft: null,
  ensureLoaded: async () => {
    if (get().loaded || get().loading) return;
    await get().reload();
  },
  reload: async () => {
    set({ loading: true });
    try {
      const items = await invoke<PromptItem[]>("list_prompts");
      set({ items, loaded: true, error: null });
    } catch (reason) {
      set({ error: String(reason), loaded: true });
    } finally {
      set({ loading: false });
    }
  },
  save: async ({ id, title, body }) => {
    const saved = await invoke<PromptItem>("save_prompt", { id: id ?? null, title, body });
    set((s) => {
      const idx = s.items.findIndex((p) => p.id === saved.id);
      if (idx < 0) return { items: [saved, ...s.items] };
      const items = [...s.items];
      items[idx] = saved;
      return { items };
    });
    return saved;
  },
  remove: async (id) => {
    await invoke("delete_prompt", { id });
    set((s) => ({ items: s.items.filter((p) => p.id !== id) }));
  },
  reorder: async (ids) => {
    const items = await invoke<PromptItem[]>("reorder_prompts", { ids });
    set({ items });
  },
  openManage: (draft = null) => {
    set({ manageOpen: true, draft: draft && draft.trim() ? draft : null });
    void get().ensureLoaded();
  },
  closeManage: () => set({ manageOpen: false, draft: null }),
}));
