import { readFileSync } from "node:fs";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { defineConfig, type Plugin, type Rollup } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** monaco 在 WKWebView 里每次 click/keydown 会 cancel 上一次剪贴板 DeferredPromise。 */
const MONACO_CLIPBOARD_CANCEL =
  "this.webKitPendingClipboardWritePromise.cancel();";
const MONACO_CLIPBOARD_CANCEL_PATCH =
  "void this.webKitPendingClipboardWritePromise.p.catch(() => {}); this.webKitPendingClipboardWritePromise.cancel();";

function patchMonacoClipboardCancel(code: string): string | null {
  if (
    !code.includes(MONACO_CLIPBOARD_CANCEL) ||
    code.includes(MONACO_CLIPBOARD_CANCEL_PATCH)
  ) {
    return null;
  }
  return code.replace(MONACO_CLIPBOARD_CANCEL, MONACO_CLIPBOARD_CANCEL_PATCH);
}

function monacoClipboardCancelPlugin(): Plugin {
  return {
    name: "monaco-clipboard-cancel",
    transform(code, id) {
      const path = id.replace(/\\/g, "/");
      if (
        !path.includes("/monaco-editor/") ||
        !path.includes("clipboardService")
      ) {
        return undefined;
      }
      const patched = patchMonacoClipboardCancel(code);
      return patched ? { code: patched, map: null } : undefined;
    },
  };
}

function monacoClipboardCancelEsbuildPlugin(): EsbuildPlugin {
  return {
    name: "monaco-clipboard-cancel",
    setup(build) {
      build.onLoad({ filter: /clipboardService\.js$/ }, (args) => {
        if (!args.path.replace(/\\/g, "/").includes("/monaco-editor/")) {
          return;
        }
        const patched = patchMonacoClipboardCancel(
          readFileSync(args.path, "utf8"),
        );
        return patched ? { contents: patched, loader: "js" } : undefined;
      });
    },
  };
}

/**
 * 启动包守卫（2026-10-26）：入口连同它静态引入的块里不得出现 monaco / mermaid / xterm / pdfjs / mammoth / xlsx。
 * 回退过两次（v1.6 首屏 224KB → 2026-10 约 8MB）：manualChunks 把共用小件收进大 vendor 块、
 * 挂在 App 上的弹层静态引了预览组件。出现就让构建失败，改成懒加载再提交。
 */
function entryGuardPlugin(): Plugin {
  const heavyChunk = /(^|\/)(monaco|mermaid|xterm)-[^/]*\.js$/;
  const heavyModule = /node_modules\/(monaco-editor|mermaid|@xterm|pdfjs-dist|mammoth|xlsx)\//;
  return {
    name: "entry-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (c): c is Rollup.OutputChunk => c.type === "chunk" && c.isEntry,
      );
      if (!entry) return;
      const seen = new Set<string>();
      const stack = [entry.fileName];
      while (stack.length) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const chunk = bundle[file];
        if (chunk?.type === "chunk") stack.push(...chunk.imports);
      }
      const bad = [...seen].flatMap((file) => {
        const chunk = bundle[file];
        if (chunk?.type !== "chunk") return [];
        if (heavyChunk.test(file)) return [file];
        return Object.keys(chunk.modules).filter((id) => heavyModule.test(id));
      });
      if (bad.length) {
        this.error(`启动包静态带上了大依赖（应懒加载）：\n  ${bad.slice(0, 8).join("\n  ")}`);
      }
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// 工作区（git worktree）或第二 clone 里跑第二个实例时，用注入的 CCODE_PORT 避免与主实例撞端口
// 默认 17575：Codex 桌面版的 NetworkService 会占用 Tauri 惯例端口 1420（本机实测冲突）
// 注意：CCODE_PORT 只改 vite 监听端口；tauri dev 加载的 devUrl（tauri.conf.json，固定
// 17575）不支持环境变量。第二实例不要临时拼 --config，直接用入库的固定配置：
// npm run tauri:dev:17576（窗口标题带「 :17576」后缀，验收按标题+端口区分实例）
// @ts-expect-error process is a nodejs global
const port = Number(process.env.CCODE_PORT ?? 17575);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), monacoClipboardCancelPlugin(), entryGuardPlugin()],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [monacoClipboardCancelEsbuildPlugin()],
    },
  },

  build: {
    rollupOptions: {
      output: {
        // 大依赖拆独立 vendor chunk：首屏只载 react + 当前页，
        // xterm 随终端页懒加载，monaco 随文件预览懒加载
        manualChunks(id: string) {
          // 入口和懒加载块都要用的小件单独成块：manualChunks 会把大 vendor 块的依赖一起收进去，
          // 入口为了 __vitePreload 静态带上整个 monaco、为了 dompurify 带上整个 mermaid
          //（2026-10-26 实测启动时多载约 6.5MB，见 architecture §10 当日「操作流畅性一批」）
          if (id.includes("vite/preload-helper") || id.includes("commonjsHelpers")) return "runtime";
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("node_modules/dompurify/")) return "dompurify";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("node_modules/@xterm/")) return "xterm";
          if (id.includes("node_modules/monaco-editor/")) {
            // 语言定义/语言服务由 monaco 内部动态 import 按需加载，保持独立小 chunk
            if (/monaco-editor\/esm\/vs\/(languages|language)\//.test(id)) {
              return undefined;
            }
            return "monaco";
          }
          if (id.includes("node_modules/mermaid")) return "mermaid";
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
