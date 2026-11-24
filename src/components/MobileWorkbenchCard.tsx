import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, Copy, ExternalLink, Info, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { fieldClass as baseFieldClass, paneOutlineButtonClass, primaryActionClass, Toggle } from "./PageFrame";
import { toast } from "../toast";
import { relTime } from "../rel-time";
import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  MAX_MOBILE_DEVICES,
  formatPairingCountdown,
  mobileWorkbenchSummary,
  tailscaleServeCommand,
  tailscaleStateLabel,
  validateCustomBaseUrl,
  validateTailscalePort,
  type MobileTunnelMode,
  type MobileWorkbenchStatusDto,
} from "../mobile-workbench";

const fieldClass = baseFieldClass.replace("w-full ", "").replace("bg-canvas", "bg-transparent").replace("py-1.5", "h-8");
const rowClass = "flex flex-wrap items-center gap-x-6 gap-y-2 py-3";
const labelClass = "w-28 shrink-0 text-base text-l1";

const INTRO_DETAIL =
  "本地服务只监听 127.0.0.1 回环，不向局域网明文开放（普通 Wi-Fi 的「从手机添加」仍保持只收不出）。经 Tailscale HTTPS 或自定义 HTTPS 隧道加密访问后，手机主屏即可看项目进展、答人工请求、与项目助手多轮流式对话、点「派出去」、只读浏览 Markdown/图片/PDF 与脱敏 Git Diff、随时 4G/5G 传资料。确认命令、评审采纳、写回与删除仍留在电脑端执行。";

async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "info");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}

/**
 * 设置 → AI 与 Agent →「手机工作台（端到端加密 PWA）」（2026-11-24）：
 * - 127.0.0.1 本机服务开关 + 本机浏览器预览；
 * - 可插拔加密通道：Tailscale Serve HTTPS（默认 8443，只操作 Mesa 专属端口）或自定义 HTTPS 隧道；
 * - 5 分钟一次性二维码配对 + 最多 8 台设备管理与一键踢出。
 */
export default function MobileWorkbenchCard() {
  const [st, setSt] = useState<MobileWorkbenchStatusDto | null>(null);
  const [tsPortInput, setTsPortInput] = useState(String(DEFAULT_TAILSCALE_HTTPS_PORT));
  const [customUrlInput, setCustomUrlInput] = useState("");
  const [pairLeft, setPairLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const prevDevCountRef = useRef<number | null>(null);

  const applyStatus = (next: MobileWorkbenchStatusDto) => {
    if (prevDevCountRef.current !== null && next.devices.length > prevDevCountRef.current) {
      toast("新手机已配对成功，可在手机浏览器点「添加到主屏幕」", "success");
    }
    prevDevCountRef.current = next.devices.length;
    setSt(next);
    setTsPortInput(String(next.tailscaleHttpsPort || DEFAULT_TAILSCALE_HTTPS_PORT));
    setCustomUrlInput((cur) => (cur ? cur : next.customBaseUrl));
    setPairLeft(next.pairingUrl ? next.pairingLeftSecs : 0);
  };

  const refresh = async (silent = true) => {
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_status");
      applyStatus(next);
      if (!silent) toast("已刷新手机工作台状态", "info");
    } catch (err) {
      if (!silent) toast(String(err), "error");
    }
  };

  useEffect(() => {
    void refresh(true);
    let off: (() => void) | null = null;
    void listen("mobile-workbench-status", () => {
      void refresh(true);
    }).then((f) => {
      off = f;
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!st?.pairingUrl || pairLeft <= 0) return;
    const t = window.setInterval(() => {
      setPairLeft((prev) => {
        if (prev <= 1) {
          void refresh(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.pairingUrl, pairLeft > 0]);

  async function saveConfig(patch: {
    enabled?: boolean;
    tunnelMode?: MobileTunnelMode;
    tailscaleHttpsPort?: number;
    customBaseUrl?: string;
  }) {
    setBusy(true);
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_set_config", {
        enabled: patch.enabled ?? st?.enabled ?? false,
        tunnelMode: patch.tunnelMode ?? null,
        tailscaleHttpsPort: patch.tailscaleHttpsPort ?? null,
        customBaseUrl: patch.customBaseUrl ?? null,
      });
      if (patch.customBaseUrl !== undefined) setCustomUrlInput(next.customBaseUrl);
      applyStatus(next);
    } catch (err) {
      toast(String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTailscaleServe(enable: boolean) {
    setBusy(true);
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_tailscale_serve", { enable });
      applyStatus(next);
      toast(enable ? "Tailscale HTTPS 通道已开启" : "Tailscale HTTPS 通道已关闭", "success");
    } catch (err) {
      toast(String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function startPairing() {
    setBusy(true);
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_pair_start");
      applyStatus(next);
    } catch (err) {
      toast(String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelPairing() {
    setBusy(true);
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_pair_cancel");
      applyStatus(next);
    } catch (err) {
      toast(String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(deviceId: string, name: string) {
    setBusy(true);
    try {
      const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_remove_device", { deviceId });
      applyStatus(next);
      toast(`已移除「${name}」，其登录凭证已立即失效`, "info");
    } catch (err) {
      toast(String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  function handleSaveTsPort() {
    const { port, error } = validateTailscalePort(tsPortInput);
    if (error) {
      toast(error, "error");
      return;
    }
    if (st && port === st.tailscaleHttpsPort) return;
    void saveConfig({ tailscaleHttpsPort: port });
  }

  function handleSaveCustomUrl() {
    const err = validateCustomBaseUrl(customUrlInput);
    if (err) {
      toast(err, "error");
      return;
    }
    void saveConfig({ tunnelMode: "custom", customBaseUrl: customUrlInput.trim() }).then(() => {
      toast("已保存自定义 HTTPS 隧道地址", "info");
    });
  }

  const tsInfo = st?.tailscale;
  const tsBadge = tsInfo ? tailscaleStateLabel(tsInfo) : { text: "检测中…", tone: "muted" as const };
  const qrSrc = st?.pairingQrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(st.pairingQrSvg)}` : null;
  const summary = st ? mobileWorkbenchSummary(st) : "读取中…";
  const localUpstream = st?.localUrl ?? (st?.port ? `http://127.0.0.1:${st.port}` : "http://127.0.0.1:<端口>");
  const cmdPreview = tailscaleServeCommand(st?.tailscaleHttpsPort ?? DEFAULT_TAILSCALE_HTTPS_PORT, st?.port ?? 0);

  return (
    <div className="mt-7">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-l1">
        <Smartphone aria-hidden="true" className="h-4 w-4 text-l3" />
        <span>手机工作台（端到端加密 PWA）</span>
        <span className="shrink-0 rounded-full bg-warn px-1.5 py-0.5 text-micro font-medium text-warn-text">
          实验功能
        </span>
        <span
          tabIndex={0}
          role="img"
          aria-label={INTRO_DETAIL}
          title={INTRO_DETAIL}
          className="inline-flex shrink-0 cursor-help rounded-sm text-l4 outline-none hover:text-l2 focus-visible:text-l1 focus-visible:ring-1 focus-visible:ring-field"
        >
          <Info aria-hidden="true" className="h-3 w-3" />
        </span>
      </h3>
      <p className="mt-0.5 text-xs leading-5 text-l3">
        实验功能，仍在持续完善中。零自建服务器，手机主屏即可看进展、问助手、只读审阅文件与 Diff、跨网传资料；仅监听 127.0.0.1，经加密通道访问（可与下方飞书提醒互补）
      </p>

      <div className="mt-2 divide-y divide-hairline border-y border-hairline">
        {/* 行 1：总开关与运行状态 */}
        <div className={rowClass}>
          <span className={labelClass}>本机服务</span>
          <span
            className={`min-w-0 flex-1 text-sm ${
              st?.running && st.publicUrl
                ? "text-ok-text"
                : st?.lastError
                  ? "text-err-text"
                  : "text-l3"
            }`}
          >
            {summary}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {st?.running && st.localUrl && (
              <button
                type="button"
                className={paneOutlineButtonClass}
                onClick={() => void openUrl(st.localUrl!).catch(() => {})}
              >
                <ExternalLink aria-hidden="true" className="mr-1 inline h-3 w-3" />
                本机预览
              </button>
            )}
            <button
              type="button"
              className={paneOutlineButtonClass}
              disabled={busy}
              onClick={() => void refresh(false)}
              title="重新检测本机与 Tailscale 状态"
            >
              <RefreshCw aria-hidden="true" className="mr-1 inline h-3 w-3" />
              刷新
            </button>
            <Toggle
              label="开启手机工作台本机服务"
              checked={Boolean(st?.enabled)}
              onChange={(checked) => void saveConfig({ enabled: checked })}
            />
          </span>
        </div>

        {/* 行 2：加密通道模式 */}
        <div className={`${rowClass} items-start`}>
          <span className={`${labelClass} pt-1`}>加密通道</span>
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                className={st?.tunnelMode === "custom" ? paneOutlineButtonClass : primaryActionClass}
                onClick={() => void saveConfig({ tunnelMode: "tailscale" })}
              >
                Tailscale HTTPS（推荐）
              </button>
              <button
                type="button"
                disabled={busy}
                className={st?.tunnelMode === "custom" ? primaryActionClass : paneOutlineButtonClass}
                onClick={() => void saveConfig({ tunnelMode: "custom" })}
              >
                自定义 HTTPS 隧道
              </button>
            </div>

            {st?.tunnelMode !== "custom" ? (
              <div className="space-y-2 rounded-lg border border-hairline bg-surface/40 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`font-medium ${
                      tsBadge.tone === "ok"
                        ? "text-ok-text"
                        : tsBadge.tone === "warn"
                          ? "text-warn-text"
                          : "text-l3"
                    }`}
                  >
                    {tsBadge.text}
                    {tsInfo?.dnsName ? ` · ${tsInfo.dnsName}` : ""}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!tsInfo?.installed && (
                      <button
                        type="button"
                        className={paneOutlineButtonClass}
                        onClick={() => void openUrl("https://tailscale.com/download").catch(() => {})}
                      >
                        下载 Tailscale
                      </button>
                    )}
                    {tsInfo?.installed && tsInfo.backendState === "Running" && !tsInfo.httpsReady && (
                      <button
                        type="button"
                        className={paneOutlineButtonClass}
                        onClick={() => void openUrl("https://login.tailscale.com/admin/dns").catch(() => {})}
                      >
                        打开 Tailscale DNS 设置
                      </button>
                    )}
                    {tsInfo?.installed && tsInfo.httpsReady && st?.running && (
                      tsInfo.serveActive ? (
                        <button
                          type="button"
                          className={paneOutlineButtonClass}
                          disabled={busy}
                          onClick={() => void toggleTailscaleServe(false)}
                        >
                          关闭 Tailscale 通道
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={primaryActionClass}
                          disabled={busy}
                          onClick={() => void toggleTailscaleServe(true)}
                        >
                          一键开启 Tailscale 通道
                        </button>
                      )
                    )}
                  </div>
                </div>
                {tsInfo?.hint && <p className="leading-5 text-l3">{tsInfo.hint}</p>}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-l3">HTTPS 端口</span>
                  <input
                    className={`${fieldClass} w-24 font-mono text-xs`}
                    value={tsPortInput}
                    onChange={(e) => setTsPortInput(e.target.value)}
                    onBlur={handleSaveTsPort}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveTsPort();
                    }}
                    aria-label="Tailscale HTTPS 端口"
                  />
                  <span className="truncate font-mono text-micro text-l4" title={cmdPreview}>
                    将执行：{cmdPreview}
                  </span>
                </div>

                {tsInfo?.serveActive && tsInfo.serveUrl && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
                    <span className="text-l3">访问地址：</span>
                    <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-l1">{tsInfo.serveUrl}</code>
                    <button
                      type="button"
                      className={paneOutlineButtonClass}
                      onClick={() => void copyText(tsInfo.serveUrl!, "已复制手机工作台地址")}
                    >
                      <Copy aria-hidden="true" className="mr-1 inline h-3 w-3" />
                      复制
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-hairline bg-surface/40 p-3 text-xs">
                <p className="leading-5 text-l3">
                  适合你自备 Cloudflare Tunnel / FRP / WireGuard / Nginx 反向代理：先将隧道上游指向本机{" "}
                  <code className="rounded bg-canvas px-1 py-0.5 font-mono text-l1">{localUpstream}</code>
                  <button
                    type="button"
                    className="ml-1.5 inline-flex items-center text-l2 underline-offset-2 hover:underline"
                    onClick={() => void copyText(localUpstream, "已复制本机上游地址")}
                  >
                    复制上游
                  </button>
                  ，再把外部 HTTPS 地址填到下方：
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`}
                    placeholder="https://mesa.example.com"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveCustomUrl();
                    }}
                  />
                  <button
                    type="button"
                    className={primaryActionClass}
                    disabled={busy}
                    onClick={handleSaveCustomUrl}
                  >
                    保存地址
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 行 3：配对新手机 */}
        <div className={`${rowClass} items-start`}>
          <span className={`${labelClass} pt-1`}>手机配对</span>
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs leading-5 text-l3">
                扫码后自动签发长期设备凭证（HttpOnly 加密 Cookie，本机仅存 SHA-256 哈希）；每张二维码 5 分钟内有效且用一次即废
              </span>
              <div className="flex gap-2">
                {st?.pairingUrl ? (
                  <button
                    type="button"
                    className={paneOutlineButtonClass}
                    disabled={busy}
                    onClick={() => void cancelPairing()}
                  >
                    取消配对
                  </button>
                ) : (
                  <button
                    type="button"
                    className={primaryActionClass}
                    disabled={busy || !st?.running || (st?.devices.length ?? 0) >= MAX_MOBILE_DEVICES}
                    onClick={() => void startPairing()}
                  >
                    配对新手机
                  </button>
                )}
              </div>
            </div>

            {st?.pairingUrl && qrSrc && (
              <div className="flex flex-wrap items-start gap-4 rounded-lg border border-hairline bg-surface/60 p-3">
                <img
                  src={qrSrc}
                  alt="扫码配对 Mesa 手机工作台"
                  className="size-36 shrink-0 rounded-md bg-white p-1.5"
                />
                <div className="min-w-0 flex-1 space-y-2 text-xs">
                  <div className="font-medium text-l1">
                    用手机相机扫码配对（剩余 {formatPairingCountdown(pairLeft)}）
                  </div>
                  {!st.publicUrl && (
                    <p className="rounded bg-warn px-2 py-1 text-l1">
                      当前未开启外网 HTTPS 通道，二维码指向本机回环地址，仅可在当前电脑浏览器测试；外网用手机扫码请先开启上方 Tailscale 或自定义 HTTPS 隧道。
                    </p>
                  )}
                  <p className="leading-5 text-l3">
                    手机打开后：iOS Safari 点底部「分享 → 添加到主屏幕」，Android Chrome 点菜单「添加到主屏幕」，即可全屏使用。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={paneOutlineButtonClass}
                      onClick={() => void copyText(st.pairingUrl!, "已复制一次性配对链接")}
                    >
                      <Copy aria-hidden="true" className="mr-1 inline h-3 w-3" />
                      复制配对链接
                    </button>
                    {!st.publicUrl && (
                      <button
                        type="button"
                        className={paneOutlineButtonClass}
                        onClick={() => void openUrl(st.pairingUrl!).catch(() => {})}
                      >
                        <ExternalLink aria-hidden="true" className="mr-1 inline h-3 w-3" />
                        在本机浏览器打开测试
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 行 4：已配对设备 */}
        <div className={`${rowClass} items-start`}>
          <span className={`${labelClass} pt-0.5`}>
            已配对设备
            <span className="ml-1 text-xs text-l4">
              ({st?.devices.length ?? 0}/{MAX_MOBILE_DEVICES})
            </span>
          </span>
          <div className="min-w-0 flex-1">
            {!st || st.devices.length === 0 ? (
              <span className="text-sm text-l3">暂无已配对手机</span>
            ) : (
              <ul className="space-y-1.5">
                {st.devices.map((dev) => (
                  <li
                    key={dev.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-l1">{dev.name}</span>
                      <span className="ml-2 text-l4">最近活跃：{relTime(dev.lastSeenAt)}</span>
                    </div>
                    <button
                      type="button"
                      className={paneOutlineButtonClass}
                      disabled={busy}
                      onClick={() => void removeDevice(dev.id, dev.name)}
                    >
                      <Trash2 aria-hidden="true" className="mr-1 inline h-3 w-3" />
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <details className="group mt-2 text-xs">
        <summary className="-ml-1 inline-flex cursor-pointer list-none items-center gap-1 text-l4 hover:text-l2 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-90" />
          第一次怎么配置（3 步）
        </summary>
        <ol className="mt-1.5 max-w-2xl list-decimal space-y-1 pl-4 leading-5 text-l3">
          <li>电脑和手机都安装免费版 Tailscale 并登录同一账号；在 Tailscale 网页后台「DNS」页开启 MagicDNS 和 HTTPS Certificates（仅需一次）。</li>
          <li>在上方打开「本机服务」，点击「一键开启 Tailscale 通道」（Mesa 仅映射自己的专属端口，默认 8443，不动你已有的其他服务）。</li>
          <li>点「配对新手机」，用手机相机扫码并在浏览器选择「添加到主屏幕」。如已有 Cloudflare Tunnel / FRP 等自备 HTTPS 隧道，也可切到「自定义 HTTPS 隧道」填入地址。</li>
        </ol>
      </details>
    </div>
  );
}
