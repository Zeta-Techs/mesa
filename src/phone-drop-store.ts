/**
 * 「从手机添加」的界面状态（docs/design-phone-drop.md）：接收状态、手机收到的列表、弹层开关、
 * 「收到的东西去哪个输入框」。后端事件在 usePhoneDropEvents（App 挂一次）里统一接，
 * 对话输入框只从 deliveries 里取属于自己的那份——避免多个监听器各自改同一条的状态。
 */
import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./toast";
import {
  IDLE_PHONE_STATUS,
  phoneStopNote,
  type PhoneDevice,
  type PhoneDropStatus,
  type PhoneItem,
} from "./phone-drop";

/** 收到的东西直接附到哪个对话输入框（ChatComposer 实例 id + 它的工作目录） */
export interface PhoneDropTarget {
  composerId: string;
  cwd: string | null;
}

interface Delivery {
  composerId: string;
  item: PhoneItem;
}

interface PhoneDropState {
  open: boolean;
  target: PhoneDropTarget | null;
  status: PhoneDropStatus;
  incoming: string | null;
  error: string | null;
  /** 正在开始 / 换地址：此间到达的旧会话「已停止」事件不作数 */
  starting: boolean;
  items: PhoneItem[];
  deliveries: Delivery[];
  /** 已配对的手机（记住这台手机） */
  devices: PhoneDevice[];
  openDialog: (target: PhoneDropTarget | null, opts?: { start?: boolean }) => void;
  /** 聊天输入框「+ → 从手机添加」：有已配对的手机就直接开始接收、不弹窗（输入框上方那一行可展开扫码）；
   *  没有就弹窗扫码配对 */
  openForComposer: (target: PhoneDropTarget) => void;
  /** 从输入框打开的：收起，接收继续（输入框上方留一行可停止）；其余：停止并关闭 */
  closeDialog: () => void;
  start: (bind?: string) => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  loadDevices: () => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
  patchItem: (item: PhoneItem) => void;
  removeItem: (id: string) => void;
  /** 手动把一条附到当前目标输入框 */
  deliver: (item: PhoneItem) => void;
  takeDeliveries: (composerId: string) => PhoneItem[];
  /** 输入框卸载：不再往它送；没送到的退回「还没处理」 */
  releaseTarget: (composerId: string) => void;
}

function setStatus(id: string, status: "new" | "attached"): Promise<PhoneItem | null> {
  return invoke<PhoneItem>("phone_drop_set_status", { id, status }).catch(() => null);
}

export const usePhoneDropStore = create<PhoneDropState>((set, get) => ({
  open: false,
  target: null,
  status: IDLE_PHONE_STATUS,
  incoming: null,
  error: null,
  starting: false,
  items: [],
  deliveries: [],
  devices: [],

  openDialog: (target, opts) => {
    set({ open: true, target, error: null });
    void get().refresh();
    void get().loadDevices();
    if (opts?.start !== false) void get().start();
  },

  openForComposer: (target) => {
    if (get().devices.length === 0) {
      get().openDialog(target);
      return;
    }
    set({ target, error: null });
    void get()
      .start()
      .then(() => {
        const { error, status } = get();
        if (error) {
          // 没开起来：弹窗里看原因
          set({ open: true });
          return;
        }
        if (!status.connected) {
          toast("已开始接收：在手机上打开主屏幕的「发到 Mesa」就能发", "info");
        }
      });
  },

  closeDialog: () => {
    const { target, status } = get();
    set({ open: false });
    if (!target && status.receiving) void get().stop();
  },

  start: async (bind) => {
    set({ starting: true, error: null });
    try {
      const status = await invoke<PhoneDropStatus>("phone_drop_start", { bind: bind ?? null });
      set({ status, incoming: null });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ starting: false });
    }
  },

  stop: async () => {
    try {
      await invoke("phone_drop_stop");
    } catch (e) {
      set({ error: String(e) });
    }
    set({ status: IDLE_PHONE_STATUS, incoming: null, target: null });
  },

  loadDevices: async () => {
    try {
      const devices = await invoke<PhoneDevice[]>("phone_drop_devices");
      set({ devices });
    } catch {
      /* 读不到名单时照常走扫码 */
    }
  },

  removeDevice: async (id) => {
    try {
      await invoke("phone_drop_remove_device", { id });
      set((s) => ({ devices: s.devices.filter((d) => d.id !== id) }));
    } catch (e) {
      toast(`移除失败：${String(e)}`, "error");
    }
  },

  refresh: async () => {
    try {
      const items = await invoke<PhoneItem[]>("phone_drop_list");
      set({ items });
    } catch {
      /* 读不到列表不打扰；弹层里照样能开始接收 */
    }
  },

  patchItem: (item) =>
    set((s) => ({ items: s.items.map((it) => (it.id === item.id ? item : it)) })),

  removeItem: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),

  deliver: (item) => {
    const target = get().target;
    if (!target) return;
    const attached = { ...item, status: "attached" as const };
    set((s) => ({
      deliveries: [...s.deliveries, { composerId: target.composerId, item: attached }],
      items: s.items.map((it) => (it.id === item.id ? attached : it)),
    }));
    void setStatus(item.id, "attached");
  },

  takeDeliveries: (composerId) => {
    const mine = get().deliveries.filter((d) => d.composerId === composerId);
    if (mine.length === 0) return [];
    set((s) => ({ deliveries: s.deliveries.filter((d) => d.composerId !== composerId) }));
    return mine.map((d) => d.item);
  },

  releaseTarget: (composerId) => {
    const { target, deliveries } = get();
    const left = deliveries.filter((d) => d.composerId === composerId);
    for (const d of left) {
      void setStatus(d.item.id, "new").then((it) => it && get().patchItem(it));
    }
    set((s) => ({
      deliveries: s.deliveries.filter((d) => d.composerId !== composerId),
      target: target?.composerId === composerId ? null : target,
    }));
  },
}));

interface StatePayload {
  receiving: boolean;
  connected: boolean;
  received: number;
  lastDevice: string | null;
  reason: string | null;
}

/** 后端事件 → 界面状态；App 挂一次。启动时读一次列表（7 天内没处理完的进收件箱） */
export function usePhoneDropEvents(): void {
  useEffect(() => {
    const store = usePhoneDropStore;
    void store.getState().refresh();
    void store.getState().loadDevices();
    void invoke<PhoneDropStatus>("phone_drop_status")
      .then((status) => store.setState({ status }))
      .catch(() => undefined);
    const offs = [
      listen<StatePayload>("phone-drop-state", (e) => {
        const p = e.payload;
        const s = store.getState();
        if (!p.receiving) {
          if (s.starting) return;
          const note = phoneStopNote(p.reason);
          store.setState({ status: IDLE_PHONE_STATUS, incoming: null, target: null });
          if (note && !s.open) toast(note, "info");
          return;
        }
        store.setState({
          status: {
            ...s.status,
            receiving: true,
            connected: p.connected,
            received: p.received,
            lastDevice: p.lastDevice,
          },
        });
      }),
      listen<PhoneDevice>("phone-drop-paired", (e) => {
        const device = e.payload;
        const s = store.getState();
        store.setState({ devices: [...s.devices.filter((d) => d.id !== device.id), device] });
        if (!s.open) toast(`已记住这台手机：${device.name}`, "success");
      }),
      listen<{ name: string }>("phone-drop-incoming", (e) => {
        store.setState({ incoming: e.payload.name });
      }),
      listen<PhoneItem>("phone-drop-item", (e) => {
        const item = e.payload;
        const s = store.getState();
        store.setState({ incoming: null, items: [item, ...s.items.filter((it) => it.id !== item.id)] });
        if (s.target) s.deliver(item);
      }),
    ];
    return () => {
      for (const off of offs) void off.then((fn) => fn());
    };
  }, []);
}
