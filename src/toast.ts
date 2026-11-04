export type ToastTone = "info" | "success" | "warning" | "error";

/** 提示里的动作按钮：点了先执行再收起这条提示 */
export type ToastAction = {
  label: string;
  onClick: () => void;
  /** 主动作（实心）；一条提示最多一个 */
  primary?: boolean;
};

export type ToastNotice = {
  id: number;
  message: string;
  tone: ToastTone;
  actions?: ToastAction[];
  /** 不按时自动消失，等人点掉（带动作、要人做决定的提示用） */
  sticky?: boolean;
  /** 同 key 的新提示替换旧的（上手引导的「下一步」只留最新一条） */
  key?: string;
  /** 事情还在办：标题前转圈，常驻到同 key 的结果提示顶替它 */
  busy?: boolean;
};

export type ToastOptions = Pick<ToastNotice, "actions" | "sticky" | "key" | "busy">;

type ToastListener = (notice: ToastNotice) => void;
type DismissListener = (key: string) => void;
type PatchListener = (id: number, actions: ToastAction[]) => void;

let nextId = 1;
const listeners = new Set<ToastListener>();
const dismissListeners = new Set<DismissListener>();
const patchListeners = new Set<PatchListener>();

export function toast(message: string, tone: ToastTone = "info", options?: ToastOptions) {
  const notice = { id: nextId++, message, tone, ...options, sticky: options?.sticky || options?.busy };
  listeners.forEach((listener) => listener(notice));
}

/** 按 key 收起提示（对应的事已经办完或不再适用） */
export function dismissToast(key: string) {
  dismissListeners.forEach((listener) => listener(key));
}

export function subscribeToasts(listener: ToastListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeToastDismiss(listener: DismissListener) {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

/** 给已经弹出来的提示补按钮（项目助手：Mesa 的后台失败归到项目后，在那条红色报错上补「问问为什么」，2026-11-04）；
 *  补了按钮的提示多留一会儿（ToastHost 重新计时） */
export function addToastActions(id: number, actions: ToastAction[]) {
  patchListeners.forEach((listener) => listener(id, actions));
}

export function subscribeToastPatch(listener: PatchListener) {
  patchListeners.add(listener);
  return () => patchListeners.delete(listener);
}
