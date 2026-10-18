export interface WebGlDiagnostics {
  supported: boolean;
  context: "webgl2" | "webgl" | null;
  renderer: string;
  vendor: string;
  maskedRenderer: string;
  maskedVendor: string;
  version: string;
  shadingLanguageVersion: string;
  debugRendererInfoAvailable: boolean;
  software: boolean;
  reason: string | null;
}

export interface FrontendDiagnostics {
  userAgent: string;
  language: string;
  languages: string[];
  platform: string;
  devicePixelRatio: number;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
  };
  webgl: WebGlDiagnostics;
}

export function isSoftwareRendererName(renderer: string): boolean {
  return /swiftshader|software|basic render|llvmpipe|lavapipe/i.test(renderer);
}

export function probeWebGL(): WebGlDiagnostics {
  const empty: WebGlDiagnostics = {
    supported: false,
    context: null,
    renderer: "",
    vendor: "",
    maskedRenderer: "",
    maskedVendor: "",
    version: "",
    shadingLanguageVersion: "",
    debugRendererInfoAvailable: false,
    software: true,
    reason: "context-unavailable",
  };
  try {
    const canvas = document.createElement("canvas");
    const webgl2 = canvas.getContext("webgl2");
    const gl = (webgl2 ?? canvas.getContext("webgl")) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) return empty;
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as
      | {
          UNMASKED_RENDERER_WEBGL: number;
          UNMASKED_VENDOR_WEBGL: number;
        }
      | null;
    const renderer = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "",
    );
    const vendor = String(
      ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "",
    );
    const software = !ext || !renderer || isSoftwareRendererName(renderer);
    const result: WebGlDiagnostics = {
      supported: true,
      context: webgl2 ? "webgl2" : "webgl",
      renderer,
      vendor,
      maskedRenderer: String(gl.getParameter(gl.RENDERER) ?? ""),
      maskedVendor: String(gl.getParameter(gl.VENDOR) ?? ""),
      version: String(gl.getParameter(gl.VERSION) ?? ""),
      shadingLanguageVersion: String(
        gl.getParameter(gl.SHADING_LANGUAGE_VERSION) ?? "",
      ),
      debugRendererInfoAvailable: !!ext,
      software,
      reason: !ext
        ? "renderer-info-unavailable"
        : !renderer
          ? "renderer-empty"
          : software
            ? "software-renderer"
            : null,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  } catch {
    return { ...empty, reason: "probe-failed" };
  }
}

/**
 * WebGL 可用性判定（纯逻辑，便于测试）。探针拿不到明确 renderer 时只有 Windows
 * 保守回退 canvas（安装版软件渲染会持续闪烁）；macOS WKWebView 等可能屏蔽 debug
 * renderer 信息但 GPU 正常，保持 WebGL 不误伤。
 */
export function webglUsable(
  probe: Pick<WebGlDiagnostics, "supported" | "debugRendererInfoAvailable" | "renderer" | "software">,
  isWindows: boolean,
): boolean {
  if (!probe.supported) return false;
  if (!probe.debugRendererInfoAvailable || !probe.renderer) return !isWindows;
  return !probe.software;
}

export function isSoftwareWebGL(): boolean {
  return !webglUsable(probeWebGL(), navigator.platform.startsWith("Win"));
}

/**
 * monaco-editor 的 CancellationError：`name` 与 `message` 都是 `"Canceled"`。
 * WKWebView 下剪贴板 workaround 每次点击/按键会取消上一次 `clipboard.write`
 * 的 DeferredPromise，拒绝是预期取消，不是故障。
 */
export function isCancellationRejection(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const rec = reason as { name?: unknown; message?: unknown };
  return rec.name === "Canceled" && rec.message === "Canceled";
}

export function collectFrontendDiagnostics(): FrontendDiagnostics {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: [...navigator.languages],
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
    },
    webgl: probeWebGL(),
  };
}

/** 应用日志条目（与后端 logbuf::LogEntryDto 对应；level 已归一为 info/warn/error） */
export interface AppLogEntry {
  ts: string;
  level: string;
  source: string;
  message: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 应用日志时间：后端记的是 UTC ISO（…Z），原样去掉 T/Z 显示会比同页「上次检测」的本地时间
 *  差出时区（东八区差 8 小时，2026-10-17 截图实证）。解析失败原样回落 */
export function logLocalTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.replace("T", " ").replace("Z", "");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 列表里的短时间（本机时区 时:分:秒）；日志缓冲只保留本次运行，日期放悬浮完整时间里 */
export function logClockTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 级别的中文短标：只给需要留意的两档，普通信息不加标（满屏「信息」等于没标） */
export function logLevelLabel(level: string): string | null {
  if (level === "error") return "错误";
  if (level === "warn") return "警告";
  return null;
}

export function logLevelCounts(logs: readonly AppLogEntry[]): {
  error: number;
  warn: number;
} {
  let error = 0;
  let warn = 0;
  for (const l of logs) {
    if (l.level === "error") error += 1;
    else if (l.level === "warn") warn += 1;
  }
  return { error, warn };
}

/** 复制/粘贴到反馈用的纯文本：一行一条，本机时间 + 级别 + 来源 */
export function formatLogText(logs: readonly AppLogEntry[]): string {
  return logs
    .map((l) => `${logLocalTime(l.ts)} [${l.level}] ${l.source}: ${l.message}`)
    .join("\n");
}
