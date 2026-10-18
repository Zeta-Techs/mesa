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
      message: `${error.stack ?? error.message}\n${info.componentStack}`,
    }).catch(() => {});
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-8 text-center">
          <p className="text-base font-medium text-err-text">界面渲染出错</p>
          <pre className="max-w-2xl overflow-auto whitespace-pre-wrap rounded-sm bg-inset p-4 text-left text-xs text-l3">
            {String(this.state.error.stack ?? this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className={secondaryActionClass}
          >
            尝试恢复
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
