import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  type Options,
} from "@tauri-apps/plugin-notification";
import { notificationPlatformOf, notificationSound } from "./notification-sound";

const SOUND = notificationSound(
  notificationPlatformOf(
    typeof navigator !== "undefined" ? navigator.platform || "" : "",
  ),
);

/** 发系统通知的唯一出口：macOS 首次发送前必须显式申请权限（系统级弹窗，仅首次），
 *  被拒则静默跳过；一律带平台对应的提示音——三家后端不指定声音就是静音，
 *  见 notification-sound.ts。调用方自己守「设置开关 / 前台不打扰 / 限频」那些门。 */
export async function sendSystemNotification(options: Options): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ sound: SOUND, ...options });
}
