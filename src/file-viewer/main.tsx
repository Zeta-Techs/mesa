import React from "react";
import ReactDOM from "react-dom/client";
import "../App.css";
import { installMesaErrorCapture } from "../mesa-error-capture";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import {
  isBrowserShortcut,
  isNavigationMouseButton,
  keepNativeContextMenu,
} from "../windows-shell";
import FileViewerApp from "./FileViewerApp";

document.documentElement.dataset.platform = IS_MAC
  ? "mac"
  : IS_WINDOWS
    ? "windows"
    : "linux";

if (IS_WINDOWS) {
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
  if (!import.meta.env.DEV) {
    window.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      const editable = Boolean(
        target?.closest("input, textarea, [contenteditable=''], [contenteditable='true']"),
      );
      const hasSelection = (window.getSelection()?.toString() ?? "") !== "";
      if (!keepNativeContextMenu({ defaultPrevented: e.defaultPrevented, editable, hasSelection })) {
        e.preventDefault();
      }
    });
  }
}

installMesaErrorCapture();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FileViewerApp />
  </React.StrictMode>,
);
