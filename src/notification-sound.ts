/** 系统通知的声音名（按平台）。
 *
 *  三家桌面通知后端都是「不指定声音 = 静音」，而且名字只能用各自认得的：
 *  - macOS：NSUserNotification 的 soundName 为空只弹横幅不出声；名字取
 *    /System/Library/Sounds 里的文件名（去扩展名）。Hero 是其中实测最响的
 *    （均值 -24 dB、峰值 -5 dB，比 Ping 高约 10 dB）。
 *  - Windows：tauri-winrt-notification 没给音频时写 `<audio silent="true"/>`，
 *    认不得的名字（比如把 mac 的 Hero 传过去）同样落成静音；只认
 *    Default / IM / Mail / Reminder / SMS 和 Alarm* / Call* 几个 ms-winsoundevent 名。
 *  - Linux：走 XDG 音主题名提示，有没有声取决于通知守护进程与音主题。
 *
 *  平台显式传参：这里不读 navigator，单测不随宿主机器变。 */
export type NotificationPlatform = "mac" | "windows" | "linux";

export function notificationSound(platform: NotificationPlatform): string {
  switch (platform) {
    case "mac":
      return "Hero";
    case "windows":
      return "Default";
    case "linux":
      return "message-new-instant";
  }
}

/** navigator.platform → 通知平台（Tauri webview 里 mac 是 "MacIntel"，Windows 是 "Win32"） */
export function notificationPlatformOf(navigatorPlatform: string): NotificationPlatform {
  if (/mac/i.test(navigatorPlatform)) return "mac";
  if (navigatorPlatform.startsWith("Win")) return "windows";
  return "linux";
}
