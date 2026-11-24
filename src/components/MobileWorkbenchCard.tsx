import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, Info } from "lucide-react";
import { fieldClass as baseFieldClass, paneOutlineButtonClass, SegTabs, Toggle } from "./PageFrame";
import { toast } from "../toast";
import { relTime } from "../rel-time";
import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  MAX_MOBILE_DEVICES,
  formatPairingCountdown,
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

const TUNNEL_ITEMS: readonly { id: MobileTunnelMode; label: string }[] = [
  { id: "tailscale", label: "Tailscale（推荐）" },
  { id: "custom", label: "自定义 HTTPS" },
];

const INTRO_DETAIL =
  "本地服务只监听 127.0.0.1 回环，不向局域网明文开放（普通 Wi-Fi 的「从手机添加」仍保持只收不出）。经 Tailscale HTTPS 或自定义 HTTPS 隧道加密访问后，手机主屏即可看进展、答人工请求、与项目助手流式对话、点「派出去」、只读审阅文件与脱敏 Diff、跨网传资料。每台手机独立配对（HttpOnly 加密 Cookie，本机 0600 文件仅存 SHA-256，最多 8 台随时移除）。确认命令、评审采纳、写回与删除仍留在电脑端执行。";

async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "info");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}

/**
 * 设置 → AI 与 Agent →「手机工作台（PWA）」（2026-11-24）：
 * 与下方 FeishuSettingsCard 保持同一套平铺细线行语言（无嵌套卡片、无竞争主蓝钮、少字干净）：
 * - 开启服务 + 本机预览
 * - 访问通道（SegTabs：Tailscale / 自定义 HTTPS）与单行状态/输入
 * - 已配对手机（列表平铺 + 配对二维码按需在底部展开）
 * - 首次配置与 Tailscale HTTPS 端口收进底部折叠
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
      if (!silent) toast("已刷新状态", "info");
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

  async function openLocalPreview() {
    if (!st?.running || !st.localUrl) return;
    // 本机还没配对过时，自动开一次一次性本机配对链直达工作台，避免打开只看到「未配对」
    if (st.devices.length === 0 && !st.publicUrl) {
      setBusy(true);
      try {
        const next = await invoke<MobileWorkbenchStatusDto>("mobile_workbench_pair_start");
        applyStatus(next);
        await openUrl(next.pairingUrl ?? st.localUrl);
        return;
      } catch (err) {
        toast(String(err), "error");
        return;
      } finally {
        setBusy(false);
      }
    }
    void openUrl(st.localUrl).catch(() => {});
  }

  async function startPairing() {
    if (!st?.publicUrl) {
      toast("请先开启上方 Tailscale 通道或保存自定义 HTTPS 地址，再生成手机扫码二维码", "info");
      return;
    }
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
      toast(`已移除「${name}」，其登录凭证已失效`, "info");
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
    void saveConfig({ tailscaleHttpsPort: port }).then(() => {
      toast(`已保存 Tailscale HTTPS 端口 ${port}`, "info");
    });
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
  const localUpstream = st?.localUrl ?? (st?.port ? `http://127.0.0.1:${st.port}` : "http://127.0.0.1:<端口>");
  const cmdPreview = tailscaleServeCommand(st?.tailscaleHttpsPort ?? DEFAULT_TAILSCALE_HTTPS_PORT, st?.port ?? 0);
  const showDetail = Boolean(st?.enabled);
  const showDevices = Boolean(st?.enabled || (st?.devices.length ?? 0) > 0);

  const serviceStatusText = !st
    ? "读取中…"
    : !st.enabled
      ? "未开启"
      : !st.running
        ? st.lastError
          ? `启动失败：${st.lastError}`
          : "正在启动…"
        : st.publicUrl
          ? `已就绪 · ${st.publicUrl}`
          : `运行中 · 127.0.0.1:${st.port}`;

  return (
    <div className="mt-7">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-l1">
        <span>手机工作台（PWA）</span>
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
        实验功能，仍在持续完善中。手机主屏看进展、问助手、只读看文件与传资料；只监听本机回环，经加密通道访问
      </p>

      <div className="mt-2 divide-y divide-hairline border-y border-hairline">
        {/* 行 1：开关与状态 */}
        <div className={rowClass}>
          <span className={labelClass}>开启服务</span>
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              st?.running && st.publicUrl
                ? "text-ok-text"
                : st?.lastError
                  ? "text-err-text"
                  : st?.running
                    ? "text-l2"
                    : "text-l3"
            }`}
            title={serviceStatusText}
          >
            {serviceStatusText}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {st?.running && st.localUrl && (
              <button
                type="button"
                className={paneOutlineButtonClass}
                disabled={busy}
                onClick={() => void openLocalPreview()}
              >
                本机预览
              </button>
            )}
            <Toggle
              label="开启手机工作台本机服务"
              checked={Boolean(st?.enabled)}
              onChange={(checked) => void saveConfig({ enabled: checked })}
            />
          </span>
        </div>

        {/* 行 2：加密通道切换 */}
        {showDetail && (
          <div className={rowClass}>
            <span className={labelClass}>加密通道</span>
            <div className="min-w-0 flex-1">
              <SegTabs
                variant="boxed"
                size="sm"
                items={TUNNEL_ITEMS}
                value={st?.tunnelMode ?? "tailscale"}
                onChange={(mode) => void saveConfig({ tunnelMode: mode })}
              />
            </div>
          </div>
        )}

        {/* 行 3：通道详情（Tailscale 状态行 或 自定义 HTTPS 输入行） */}
        {showDetail && st?.tunnelMode !== "custom" && (
          <div className={rowClass}>
            <span className={labelClass}>Tailscale</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span
                  className={
                    tsBadge.tone === "ok"
                      ? "text-ok-text"
                      : tsBadge.tone === "warn"
                        ? "text-warn-text"
                        : "text-l3"
                  }
                >
                  {tsBadge.text}
                </span>
                {tsInfo?.serveActive && tsInfo.serveUrl ? (
                  <code className="truncate font-mono text-xs text-l2">{tsInfo.serveUrl}</code>
                ) : tsInfo?.dnsName ? (
                  <span className="truncate font-mono text-xs text-l4">{tsInfo.dnsName}</span>
                ) : null}
              </div>
              {!tsInfo?.serveActive && tsInfo?.hint && (
                <p className="mt-0.5 text-xs leading-5 text-l3">{tsInfo.hint}</p>
              )}
            </div>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                className={paneOutlineButtonClass}
                disabled={busy}
                onClick={() => void refresh(false)}
              >
                刷新
              </button>
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
                  打开 DNS 设置
                </button>
              )}
              {tsInfo?.installed && tsInfo.httpsReady && st?.running && (
                tsInfo.serveActive ? (
                  <>
                    {tsInfo.serveUrl && (
                      <button
                        type="button"
                        className={paneOutlineButtonClass}
                        onClick={() => void copyText(tsInfo.serveUrl!, "已复制访问地址")}
                      >
                        复制地址
                      </button>
                    )}
                    <button
                      type="button"
                      className={paneOutlineButtonClass}
                      disabled={busy}
                      onClick={() => void toggleTailscaleServe(false)}
                    >
                      关闭通道
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={paneOutlineButtonClass}
                    disabled={busy}
                    onClick={() => void toggleTailscaleServe(true)}
                  >
                    开启通道
                  </button>
                )
              )}
            </span>
          </div>
        )}

        {showDetail && st?.tunnelMode === "custom" && (
          <div className={rowClass}>
            <span className={labelClass}>隧道地址</span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
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
                  className={paneOutlineButtonClass}
                  disabled={busy}
                  onClick={handleSaveCustomUrl}
                >
                  保存
                </button>
              </div>
              <p className="text-xs text-l3">
                反代上游指向 <code className="font-mono text-l2">{localUpstream}</code>
                <button
                  type="button"
                  className="ml-2 text-l2 underline-offset-2 hover:underline"
                  onClick={() => void copyText(localUpstream, "已复制本机上游地址")}
                >
                  复制上游
                </button>
              </p>
            </div>
          </div>
        )}

        {/* 行 4：已配对手机（与下方飞书「绑定的人」对齐） */}
        {showDevices && (
          <div className={`${rowClass} items-start`}>
            <span className={`${labelClass} pt-0.5`}>已配对手机</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-l3">
                  {st && st.devices.length > 0
                    ? `已配对 ${st.devices.length} / ${MAX_MOBILE_DEVICES} 台`
                    : "暂无已配对手机"}
                </span>
                {st?.enabled && (
                  <span className="flex gap-2">
                    {st.pairingUrl && st.publicUrl ? (
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
                        className={paneOutlineButtonClass}
                        disabled={busy || !st.running || !st.publicUrl || st.devices.length >= MAX_MOBILE_DEVICES}
                        title={!st.publicUrl ? "需先开启上方加密通道，才能生成供手机扫码的二维码" : undefined}
                        onClick={() => void startPairing()}
                      >
                        配对新手机
                      </button>
                    )}
                  </span>
                )}
              </div>

              {st?.enabled && st.running && !st.publicUrl && (
                <p className="mt-1 text-xs leading-5 text-l3">
                  需先开启上方加密通道，才能生成手机扫码二维码（未开通道时 127.0.0.1 仅本机可访问，手机无法连接）
                </p>
              )}

              {st && st.devices.length > 0 && (
                <ul className="mt-2 divide-y divide-hairline/60 border-t border-hairline/60">
                  {st.devices.map((dev) => (
                    <li key={dev.id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-l1">{dev.name}</span>
                        <span className="ml-2 text-l4">最近活跃 {relTime(dev.lastSeenAt)}</span>
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-xs text-l3 transition-colors hover:text-err-text disabled:opacity-45"
                        disabled={busy}
                        onClick={() => void removeDevice(dev.id, dev.name)}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 配对二维码条：仅在外网加密通道就绪且点击「配对新手机」后展开，杜绝展示 127.0.0.1 假二维码 */}
      {st?.publicUrl && st.pairingUrl && qrSrc && (
        <div className="mt-2.5 flex flex-wrap items-center gap-4 rounded-lg bg-surface/60 px-3.5 py-3 text-xs">
          <img
            src={qrSrc}
            alt="扫码配对 Mesa 手机工作台"
            className="size-44 shrink-0 rounded-md bg-white p-2.5"
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="font-medium text-l1">
              用手机自带相机扫码配对（剩余 {formatPairingCountdown(pairLeft)}，用一次即废）
            </div>
            <p className="leading-5 text-l3">
              请使用系统相机（勿用微信扫一扫），并确认手机已连接同一 Tailscale 账号；打开后在浏览器菜单点「添加到主屏幕」即可全屏使用。
            </p>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                className={paneOutlineButtonClass}
                onClick={() => void copyText(st.pairingUrl!, "已复制一次性配对链接")}
              >
                复制配对链接
              </button>
            </div>
          </div>
        </div>
      )}

      <details className="group mt-2 text-xs">
        <summary className="-ml-1 inline-flex cursor-pointer list-none items-center gap-1 text-l4 hover:text-l2 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-90" />
          第一次怎么配置与端口设置
        </summary>
        <div className="mt-1.5 max-w-2xl space-y-2.5 leading-5 text-l3">
          <ol className="list-decimal space-y-1 pl-4">
            <li>电脑和手机安装免费版 Tailscale 并登录同一账号；在 Tailscale 网页后台「DNS」页开启 MagicDNS 与 HTTPS Certificates（仅需一次）。</li>
            <li>打开上方「开启服务」，点击「开启通道」（仅映射 Mesa 专属 HTTPS 端口，不动你已有的其他服务）。</li>
            <li>点「配对新手机」扫码并在浏览器选「添加到主屏幕」。自备 Cloudflare Tunnel / FRP 等隧道时可切到「自定义 HTTPS」。</li>
          </ol>
          {st?.tunnelMode !== "custom" && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <span>Tailscale HTTPS 端口</span>
              <input
                className={`${fieldClass} w-20 font-mono text-xs`}
                value={tsPortInput}
                onChange={(e) => setTsPortInput(e.target.value)}
                onBlur={handleSaveTsPort}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveTsPort();
                }}
                aria-label="Tailscale HTTPS 端口"
              />
              <span className="truncate font-mono text-micro text-l4" title={cmdPreview}>
                {cmdPreview}
              </span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
