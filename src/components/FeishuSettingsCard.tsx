import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, Info } from "lucide-react";
import { fieldClass as baseFieldClass, paneOutlineButtonClass, primaryActionClass } from "./PageFrame";
import { toast } from "../toast";
import { forgetImConfig, type FeishuConfig } from "../im-bridge";

/** 设置页的输入框口径：细边、透明底、32px（同 SettingsPage 的 fieldFixed） */
const fieldClass = baseFieldClass.replace("w-full ", "").replace("bg-canvas", "bg-transparent").replace("py-1.5", "h-8");
const rowClass = "flex flex-wrap items-center gap-x-6 gap-y-2 py-3";
const labelClass = "w-24 shrink-0 text-base text-l1";

/** 卡头 ⓘ 里的全文：能在手机上做什么、什么仍要回电脑 */
const INTRO_DETAIL =
  "可以交代要做的事、点「派出去」、回会话里在问你的事、收派活进展。电脑上的 Mesa 开着才收得到；确认命令、评审采纳、写回项目仍要回到电脑上做。密钥与文件正文不发给飞书。";

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
  // 外形同设置页 Card + Row：粗体节标题 + 一句说明（细节进 ⓘ），下面一行一项、行间细线；
  // 第一次的设置步骤是低频内容，收进折叠
  return (
    <div className="mt-7">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-l1">
        <span>手机上的项目助手（飞书）</span>
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
      <p className="mt-0.5 text-xs leading-5 text-l3">在飞书里跟项目助手说话；会话摘要和问题会经过飞书的服务器</p>
      <div className="mt-2 divide-y divide-hairline border-y border-hairline">
        <div className={rowClass}>
          <span className={labelClass}>App ID</span>
          <input className={`${fieldClass} min-w-0 flex-1`} value={appId} placeholder="cli_…（飞书开放平台 → 自建应用）" onChange={(e) => setAppId(e.target.value)} />
        </div>
        <div className={rowClass}>
          <span className={labelClass}>App Secret</span>
          <input
            className={`${fieldClass} min-w-0 flex-1`}
            type="password"
            value={secret}
            placeholder={cfg?.hasSecret ? "已存（不显示）；要换就填新的" : "只存在本机，不显示"}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <div className={rowClass}>
          <span className={labelClass}>状态</span>
          <span className={`min-w-0 flex-1 text-sm ${cfg?.status === "online" ? "text-ok-text" : cfg?.status === "error" ? "text-err-text" : "text-l3"}`}>
            {status}
            {cfg?.lastError ? `：${cfg.lastError}` : ""}
          </span>
          <span className="flex gap-2">
            {cfg?.enabled ? (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void save(false)}>
                关掉
              </button>
            ) : (
              <button type="button" className={primaryActionClass} disabled={busy || !appId.trim() || (!secret.trim() && !cfg?.hasSecret)} onClick={() => void save(true)}>
                保存并打开
              </button>
            )}
            {cfg?.enabled && secret.trim() && (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void save(true)}>
                换上新的 Secret
              </button>
            )}
            <button type="button" className={paneOutlineButtonClass} disabled={busy || !cfg?.hasSecret} onClick={() => void run("feishu_test")}>
              测试连接
            </button>
          </span>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>绑定的人</span>
          <span className="min-w-0 flex-1 text-sm text-l3">{cfg?.boundUser ? `已绑定（${cfg.boundUser}）` : "还没绑定"}</span>
          <span className="flex gap-2">
            {cfg?.boundUser ? (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void run("feishu_unbind")}>
                解绑
              </button>
            ) : (
              <button type="button" className={paneOutlineButtonClass} disabled={busy || cfg?.status !== "online"} onClick={() => void run("feishu_pair_start")}>
                绑定
              </button>
            )}
          </span>
        </div>
      </div>
      {code && !cfg?.boundUser && (
        <p className="mt-2 rounded-lg bg-warn px-3 py-2 text-sm text-l1">
          在飞书里打开这个机器人，发一句 <span className="font-mono font-semibold">绑定 {code}</span>（10 分钟内有效）。绑定后只听你一个人的。
        </p>
      )}
      <details className="group mt-2 text-xs">
        <summary className="-ml-1 inline-flex cursor-pointer list-none items-center gap-1 text-l4 hover:text-l2 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-90" />
          第一次怎么设置
        </summary>
        <p className="mt-1.5 max-w-2xl leading-5 text-l3">
          飞书开放平台建企业自建应用、加「机器人」能力、开通消息权限 → 把 App ID / Secret 填到上面并打开，等「已连上」→
          回飞书后台「事件与回调」，事件与回调都选长连接，加「接收消息」事件和「卡片回传交互」回调（飞书保存长连接设置时要检查已连上）→ 创建版本并发布 → 点「绑定」。
          详细步骤见说明书「在手机上用项目助手（飞书）」。
        </p>
      </details>
    </div>
  );
}
