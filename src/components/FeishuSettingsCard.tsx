import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { compactFieldClass, ghostActionClass, primaryActionClass, secondaryActionClass } from "./PageFrame";
import { toast } from "../toast";
import { forgetImConfig, type FeishuConfig } from "../im-bridge";

const STATUS_TEXT: Record<string, string> = {
  off: "没开",
  connecting: "正在连…",
  online: "已连上",
  error: "连不上",
};

/**
 * 设置 → AI 与 Agent →「手机上的项目助手（飞书）」（2026-11-06 docs/design-assistant-dispatch-desk.md §1 第 5 条、§3）：
 * 填自建飞书应用的 App ID / App Secret（Secret 只进 0600 keys.json，不回显）→ 打开 → 测试连接 → 点「绑定」出 6 位码，在飞书里发给机器人。
 * 只听绑定的那一个人；Mesa 开着时才收得到。配对永远要人点开始。
 */
export default function FeishuSettingsCard() {
  const [cfg, setCfg] = useState<FeishuConfig | null>(null);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void invoke<FeishuConfig>("feishu_config_get")
      .then((c) => {
        setCfg(c);
        setAppId((cur) => cur || c.appId);
      })
      .catch(() => setCfg(null));

  useEffect(() => {
    load();
    let off: (() => void) | null = null;
    void listen("feishu-status", () => {
      forgetImConfig();
      load();
    }).then((f) => (off = f));
    return () => off?.();
  }, []);

  async function save(enabled: boolean) {
    setBusy(true);
    try {
      const next = await invoke<FeishuConfig>("feishu_config_set", {
        appId: appId.trim(),
        appSecret: secret.trim() ? secret.trim() : null,
        enabled,
      });
      setCfg(next);
      setSecret("");
      forgetImConfig();
    } catch (reason) {
      toast(String(reason), "error");
    } finally {
      setBusy(false);
    }
  }

  async function run(cmd: "feishu_test" | "feishu_pair_start" | "feishu_unbind") {
    setBusy(true);
    try {
      if (cmd === "feishu_test") toast(await invoke<string>("feishu_test"), "info");
      else if (cmd === "feishu_pair_start") setCode(await invoke<string>("feishu_pair_start"));
      else {
        setCfg(await invoke<FeishuConfig>("feishu_unbind"));
        forgetImConfig();
      }
    } catch (reason) {
      toast(String(reason), "error");
    } finally {
      setBusy(false);
    }
  }

  const status = cfg ? (STATUS_TEXT[cfg.status] ?? cfg.status) : "读不到";
  return (
    <div className="mt-7">
      <h3 className="text-base font-semibold text-l1">手机上的项目助手（飞书）</h3>
      <p className="mt-0.5 text-xs leading-5 text-l3">
        在飞书里跟项目助手说话：交代要做的事、点「派出去」、回会话里在问你的事、收派活进展。电脑上的 Mesa 开着才收得到；确认命令、评审采纳、写回项目仍要回到电脑上做。
        会话摘要和问题会经过飞书的服务器，密钥与文件正文不发。
      </p>
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-l2">App ID</span>
          <input className={`${compactFieldClass} min-w-0 flex-1`} value={appId} placeholder="cli_…（飞书开放平台 → 自建应用）" onChange={(e) => setAppId(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-l2">App Secret</span>
          <input
            className={`${compactFieldClass} min-w-0 flex-1`}
            type="password"
            value={secret}
            placeholder={cfg?.hasSecret ? "已存（不显示）；要换就填新的" : "只存在本机，不显示"}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-l2">状态</span>
          <span className={cfg?.status === "online" ? "text-ok-text" : cfg?.status === "error" ? "text-err-text" : "text-l3"}>
            {status}
            {cfg?.lastError ? `：${cfg.lastError}` : ""}
          </span>
          <span className="ml-auto flex gap-1.5">
            {cfg?.enabled ? (
              <button type="button" className={ghostActionClass} disabled={busy} onClick={() => void save(false)}>
                关掉
              </button>
            ) : (
              <button type="button" className={primaryActionClass} disabled={busy || !appId.trim() || (!secret.trim() && !cfg?.hasSecret)} onClick={() => void save(true)}>
                保存并打开
              </button>
            )}
            {cfg?.enabled && secret.trim() && (
              <button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void save(true)}>
                换上新的 Secret
              </button>
            )}
            <button type="button" className={ghostActionClass} disabled={busy || !cfg?.hasSecret} onClick={() => void run("feishu_test")}>
              测试连接
            </button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-l2">绑定的人</span>
          <span className="text-l3">{cfg?.boundUser ? `已绑定（${cfg.boundUser}）` : "还没绑定"}</span>
          <span className="ml-auto flex gap-1.5">
            {cfg?.boundUser ? (
              <button type="button" className={ghostActionClass} disabled={busy} onClick={() => void run("feishu_unbind")}>
                解绑
              </button>
            ) : (
              <button type="button" className={secondaryActionClass} disabled={busy || cfg?.status !== "online"} onClick={() => void run("feishu_pair_start")}>
                绑定
              </button>
            )}
          </span>
        </div>
        {code && !cfg?.boundUser && (
          <p className="rounded-lg bg-warn px-3 py-2 text-sm text-l1">
            在飞书里打开这个机器人，发一句 <span className="font-mono font-semibold">绑定 {code}</span>（10 分钟内有效）。绑定后只听你一个人的。
          </p>
        )}
        <p className="text-xs leading-5 text-l4">
          第一次用：到飞书开放平台建一个企业自建应用，开「机器人」能力；事件订阅选「使用长连接接收事件」，加上「接收消息」事件；卡片回调同样选长连接；
          权限加「获取与发送单聊、群组消息」。发布版本后把 App ID / Secret 填到上面。
        </p>
      </div>
    </div>
  );
}
