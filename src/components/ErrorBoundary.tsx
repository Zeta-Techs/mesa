import { Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  secondaryActionClass,
} from "./PageFrame";
interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

function isModuleLoadError(error: Error | null): boolean {
  const msg = String(error?.message ?? error ?? "");
  return /Importing binding name|Failed to fetch dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    msg,
  );
}

/** WebKit（macOS WKWebView）的 error.stack 不带错误标题，补上「类型: 原因」便于直接定位 */
function formatBoundaryError(error: Error): string {
  const header = error.message ? `${error.name || "Error"}: ${error.message}` : String(error);
  const stack = error.stack?.trim() ?? "";
  if (!stack) return header;
  return error.message && stack.includes(error.message) ? stack : `${header}\n${stack}`;
}

/** 顶层错误边界：前端崩溃时显示错误而不是整窗白屏（webview 无控制台可看的定位手段） */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
    void invoke("log_event", {
      level: "error",
      source: "react-error-boundary",
      message: `${formatBoundaryError(error)}\n${info.componentStack}`,
    }).catch(() => {});
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-8 text-center">
          <p className="text-base font-medium text-err-text">界面渲染出错</p>
          <pre className="max-w-2xl overflow-auto whitespace-pre-wrap rounded-sm bg-inset p-4 text-left text-xs text-l3">
            {formatBoundaryError(this.state.error)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (isModuleLoadError(this.state.error)) {
                  window.location.reload();
                  return;
                }
                this.setState({ error: null });
              }}
              className={secondaryActionClass}
            >
              尝试恢复
            </button>
            <button
              onClick={() => window.location.reload()}
              className={secondaryActionClass}
            >
              重新加载界面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
