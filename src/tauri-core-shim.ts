/**
 * `@tauri-apps/api/core` 的薄包装（vite.config.ts 用别名把应用里的 `@tauri-apps/api/core` 指到这里）。
 * 只多做一件事：后台调用失败时通知 Mesa 出错记录（mesa-error-capture.ts），再原样抛出。
 * Tauri 注入的 `__TAURI_INTERNALS__.invoke` 是不可改写的属性，包不住，只能在导入这一层包。
 * 其余导出原样转出；测试（node / esbuild）不走 Vite 别名，直接用原模块。
 */
import {
  Channel,
  PluginListener,
  Resource,
  SERIALIZE_TO_IPC_FN,
  addPluginListener,
  checkPermissions,
  convertFileSrc,
  invoke as tauriInvoke,
  isTauri,
  requestPermissions,
  transformCallback,
} from "../node_modules/@tauri-apps/api/core.js";
import type { InvokeArgs, InvokeOptions } from "../node_modules/@tauri-apps/api/core.js";

export type * from "../node_modules/@tauri-apps/api/core.js";
export {
  Channel,
  PluginListener,
  Resource,
  SERIALIZE_TO_IPC_FN,
  addPluginListener,
  checkPermissions,
  convertFileSrc,
  isTauri,
  requestPermissions,
  transformCallback,
};

type FailureHook = (cmd: string, args: InvokeArgs | undefined, error: unknown) => void;
let failureHook: FailureHook | null = null;

export function setInvokeFailureHook(hook: FailureHook | null) {
  failureHook = hook;
}

/** 不经出错记录的原始调用（出错记录自己上报时用，免得绕回来） */
export const rawInvoke = tauriInvoke;

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return tauriInvoke<T>(cmd, args, options).catch((error: unknown) => {
    try {
      failureHook?.(cmd, args, error);
    } catch {
      // 记录出错不影响原调用的报错
    }
    throw error;
  });
}
