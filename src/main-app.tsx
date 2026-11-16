/**
 * 主窗口启动（main.tsx 懒加载后调 boot()）。本模块顶层只做声明、不执行任何动作：
 * 文件查看 / 桌宠窗口懒载的块与主窗口共用模块，打包时可能落进本块，一引就执行顶层代码。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installMesaErrorCapture } from "./mesa-error-capture";
import { IS_MAC, IS_WINDOWS } from "./hotkeys";
import {
  isBrowserShortcut,
  isNavigationMouseButton,
  isWindows11PlatformVersion,
  keepNativeContextMenu,
} from "./windows-shell";

export function boot(): void {
  // 平台标记：Windows 的文字光栅化（DirectWrite 灰度抗锯齿）与 macOS 差异大，
  // App.css 据此区分字体栈与 text-rendering
  document.documentElement.dataset.platform = IS_MAC
    ? "mac"
    : IS_WINDOWS
      ? "windows"
      : "linux";

  if (IS_WINDOWS) {
    // WebView2 浏览器默认行为收口（判定与理由见 windows-shell.ts）。捕获阶段只 preventDefault，
    // 应用自己的处理照常收到事件
    window.addEventListener(
      "keydown",
      (e) => {
        if (isBrowserShortcut(e)) e.preventDefault();
      },
      true,
    );
    window.addEventListener(
      "mouseup",
      (e) => {
        if (isNavigationMouseButton(e.button)) e.preventDefault();
      },
      true,
    );
    // 开发版保留默认右键（要用「检查」）；冒泡阶段判定，应用自绘菜单已 preventDefault 的不动
    if (!import.meta.env.DEV) {
      window.addEventListener("contextmenu", (e) => {
        const target = e.target as HTMLElement | null;
        const editable = Boolean(
          target?.closest("input, textarea, [contenteditable=''], [contenteditable='true']"),
        );
        const hasSelection = (window.getSelection()?.toString() ?? "") !== "";
        if (!keepNativeContextMenu({ defaultPrevented: e.defaultPrevented, editable, hasSelection }))
          e.preventDefault();
      });
    }
    // Windows 10 没有 Mica：标记后 App.css 回到实心底（否则深色主题透出桌面）
    const uaData = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }> };
    }).userAgentData;
    void uaData
      ?.getHighEntropyValues(["platformVersion"])
      .then(({ platformVersion }) => {
        if (platformVersion && !isWindows11PlatformVersion(platformVersion))
          document.documentElement.dataset.material = "none";
      })
      .catch(() => {});
  }

  // Mesa 出错记录：失败的后台调用按项目留底，项目助手据此判断是不是 Mesa 的问题
  installMesaErrorCapture();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
