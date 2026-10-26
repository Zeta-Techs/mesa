// 页面里没有 Tauri：给聊天区要问后端的几样一个慢一点的假回答（行内文件链接按「都是文件」，引用库按没有）
window.addEventListener("error", (e) => { window.__result = { error: String(e.message) }; });
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    if (cmd === "home_dir") return "/Users/x";
    if (cmd === "existing_files") {
      await new Promise((r) => setTimeout(r, 90));
      return (args.paths || []).map((p) => ({ path: p, abs: "/abs/" + p }));
    }
    if (cmd === "cite_lookup") {
      await new Promise((r) => setTimeout(r, 90));
      return { bibFound: false, entries: [] };
    }
    return cmd.startsWith("list") ? [] : null;
  },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
