import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, Info } from "lucide-react";
import { fieldClass as baseFieldClass, paneOutlineButtonClass, primaryActionClass, Toggle } from "./PageFrame";
import { toast } from "../toast";
import { forgetImConfig, type FeishuConfig } from "../im-bridge";

/** 设置页的输入框口径：细边、透明底、32px（同 SettingsPage 的 fieldFixed） */
const fieldClass = baseFieldClass.replace("w-full ", "").replace("bg-canvas", "bg-transparent").replace("py-1.5", "h-8");
const rowClass = "flex flex-wrap items-center gap-x-6 gap-y-2 py-3";

/** 卡头 ⓘ 里的全文：能在手机上做什么、什么仍要回电脑 */
const INTRO_DETAIL =
  "可以交代要做的事、点「派出去」、左滑引用回复会话或请求、发「进展」秒看状态、收步骤与派活进展。电脑上的 Mesa 开着才收得到；确认命令、评审采纳、写回项目仍要回到电脑上做。密钥与文件正文不发给飞书。";

/** 飞书开放平台「权限管理 → 批量导入/导出权限」可直接粘贴的最小权限集 */
const FEISHU_PERMISSION_JSON = JSON.stringify(
  {
    scopes: {
      tenant: ["im:message", "im:message.p2p_msg:readonly", "im:message:send_as_bot"],
      user: [],
    },
  },
  null,
  2,
);

const STATUS_TEXT: Record<string, string> = {
  off: "没开",
  connecting: "正在连…",
  online: "已连上",
  error: "连不上",
};

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "info");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}

/**
 * 设置 → AI 与 Agent →「手机上的项目助手（飞书）」（2026-11-06 docs/design-assistant-dispatch-desk.md §1 第 5 条、§3；2026-11-24 对齐通用设置分组卡）：
 * 填自建飞书应用的 App ID / App Secret（Secret 只进 0600 keys.json，不回显）→ 打开 → 测试连接 → 点「绑定」出 6 位码，在飞书里发给机器人。
 * 只听绑定的那一个人；Mesa 开着时才收得到。配对永远要人点开始。
 */
export default function FeishuSettingsCard() {
  const [cfg, setCfg] = useState<FeishuConfig | null>(null);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [pairLeft, setPairLeft] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const prevBoundRef = useRef<string | null | undefined>(undefined);

  const applyCfg = (c: FeishuConfig) => {
    const prevBound = prevBoundRef.current;
    prevBoundRef.current = c.boundUser;
    if (prevBound === null && c.boundUser) {
      toast("已绑定飞书账号，可以在手机上发消息了", "success");
    }
    setCfg(c);
    setAppId((cur) => cur || c.appId);
    if (c.boundUser) {
      setCode(null);
      setPairLeft(0);
    } else if (c.pairingCode) {
      setCode(c.pairingCode);
      setPairLeft(c.pairingLeftSecs ?? 600);
    }
  };

  const load = () =>
    void invoke<FeishuConfig>("feishu_config_get")
      .then(applyCfg)
      .catch(() => setCfg(null));

  useEffect(() => {
    load();
    let off: (() => void) | null = null;
    void listen("feishu-status", () => {
      forgetImConfig();
      load();
    }).then((f) => (off = f));
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!code || cfg?.boundUser || pairLeft <= 0) return;
    const t = window.setInterval(() => {
      setPairLeft((prev) => {
        if (prev <= 1) {
          setCode(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [code, cfg?.boundUser, pairLeft > 0]);

  async function save(enabled: boolean) {
    setBusy(true);
    try {
      const next = await invoke<FeishuConfig>("feishu_config_set", {
        appId: appId.trim(),
        appSecret: secret.trim() ? secret.trim() : null,
        enabled,
      });
      applyCfg(next);
      setSecret("");
      forgetImConfig();
    } catch (reason) {
      toast(String(reason), "error");
    } finally {
      setBusy(false);
    }
  }

  async function updatePrefs(notifyMilestones: boolean, quietNight: boolean) {
    try {
      const next = await invoke<FeishuConfig>("feishu_prefs_set", { notifyMilestones, quietNight });
      applyCfg(next);
      forgetImConfig();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  async function run(
    cmd: "feishu_test" | "feishu_pair_start" | "feishu_unbind" | "feishu_reconnect" | "feishu_send_test_card",
  ) {
    setBusy(true);
    try {
      if (cmd === "feishu_test") toast(await invoke<string>("feishu_test"), "info");
      else if (cmd === "feishu_pair_start") {
        const nextCode = await invoke<string>("feishu_pair_start");
        setCode(nextCode);
        setPairLeft(600);
      } else if (cmd === "feishu_reconnect") {
        applyCfg(await invoke<FeishuConfig>("feishu_reconnect"));
        forgetImConfig();
        toast("正在重新连接飞书…", "info");
      } else if (cmd === "feishu_send_test_card") {
        toast(await invoke<string>("feishu_send_test_card"), "info");
      } else {
        const next = await invoke<FeishuConfig>("feishu_unbind");
        prevBoundRef.current = next.boundUser;
        setCfg(next);
        setCode(null);
        setPairLeft(0);
        forgetImConfig();
      }
    } catch (reason) {
      toast(String(reason), "error");
    } finally {
      setBusy(false);
    }
  }

  const status = cfg ? (STATUS_TEXT[cfg.status] ?? cfg.status) : "读不到";
  const showPrefs = Boolean(cfg?.enabled || cfg?.hasSecret);

  return (
    <div className="mt-6">
      <div className="mb-2 px-0.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-l2">
          <span>手机上的项目助手（飞书）</span>
          <span className="shrink-0 rounded-full bg-warn px-1.5 py-0.5 text-micro font-medium tracking-normal text-warn-text">
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
      </div>

      <div className="ccode-well divide-y divide-hairline overflow-hidden rounded-xl border border-hairline px-4">
        <div className={rowClass}>
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">App ID</div>
          </div>
          <div className="flex min-w-0 max-w-full items-center justify-end">
            <input
              className={`${fieldClass} w-72 max-w-full font-mono text-xs`}
              value={appId}
              placeholder="cli_…（飞书开放平台 → 自建应用）"
              onChange={(e) => setAppId(e.target.value)}
            />
          </div>
        </div>

        <div className={rowClass}>
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">App Secret</div>
          </div>
          <div className="flex min-w-0 max-w-full items-center justify-end">
            <input
              className={`${fieldClass} w-72 max-w-full font-mono text-xs`}
              type="password"
              value={secret}
              placeholder={cfg?.hasSecret ? "已存（不显示）；要换就填新的" : "只存在本机，不显示"}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        </div>

        <div className={rowClass}>
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">连接状态</div>
            <p
              className={`mt-0.5 max-w-xl text-xs leading-relaxed ${
                cfg?.status === "online" ? "text-ok-text" : cfg?.status === "error" ? "text-err-text" : "text-l3"
              }`}
            >
              {status}
              {cfg?.lastError ? `：${cfg.lastError}` : ""}
            </p>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {cfg?.enabled ? (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void save(false)}>
                关掉
              </button>
            ) : (
              <button
                type="button"
                className={primaryActionClass}
                disabled={busy || !appId.trim() || (!secret.trim() && !cfg?.hasSecret)}
                onClick={() => void save(true)}
              >
                保存并打开
              </button>
            )}
            {cfg?.enabled && secret.trim() && (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void save(true)}>
                换上新的 Secret
              </button>
            )}
            {cfg?.enabled && (cfg.status === "connecting" || cfg.status === "error") && (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void run("feishu_reconnect")}>
                立即重连
              </button>
            )}
            <button type="button" className={paneOutlineButtonClass} disabled={busy || !cfg?.hasSecret} onClick={() => void run("feishu_test")}>
              测试连接
            </button>
            {cfg?.enabled && cfg.boundUser && cfg.status === "online" && (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void run("feishu_send_test_card")}>
                发测试卡片
              </button>
            )}
          </div>
        </div>

        <div className={rowClass}>
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-medium text-l1">绑定的人</div>
            <p className="mt-0.5 text-xs leading-relaxed text-l3">
              {cfg?.boundUser ? `已绑定（${cfg.boundUser}）` : "还没绑定；绑定后只听你一个人的私聊"}
            </p>
          </div>
          <div className="flex min-w-0 max-w-full items-center justify-end gap-2">
            {cfg?.boundUser ? (
              <button type="button" className={paneOutlineButtonClass} disabled={busy} onClick={() => void run("feishu_unbind")}>
                解绑
              </button>
            ) : (
              <button type="button" className={paneOutlineButtonClass} disabled={busy || cfg?.status !== "online"} onClick={() => void run("feishu_pair_start")}>
                绑定
              </button>
            )}
          </div>
          {code && !cfg?.boundUser && (
            <div className="basis-full pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn px-3 py-2 text-xs text-l1">
                <span>
                  在飞书里打开这个机器人，发一句 <span className="font-mono font-semibold">绑定 {code}</span>
                  {pairLeft > 0 ? `（剩余 ${formatCountdown(pairLeft)}）` : ""}
                </span>
                <button
                  type="button"
                  className={paneOutlineButtonClass}
                  onClick={() => void copyText(`绑定 ${code}`, "已复制绑定口令")}
                >
                  复制口令
                </button>
              </div>
            </div>
          )}
        </div>

        {showPrefs && (
          <>
            <div className={rowClass}>
              <div className="min-w-[12rem] flex-1">
                <div className="text-sm font-medium text-l1">步骤与目标通知</div>
                <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-l3">
                  步骤做完等评审、目标待验收或出错时主动发卡片（能一键让项目助手先看一遍）
                </p>
              </div>
              <div className="flex min-w-0 max-w-full items-center justify-end">
                <Toggle
                  checked={cfg?.notifyMilestones ?? true}
                  onChange={(v) => void updatePrefs(v, cfg?.quietNight ?? false)}
                  label="步骤与目标通知"
                />
              </div>
            </div>

            <div className={rowClass}>
              <div className="min-w-[12rem] flex-1">
                <div className="text-sm font-medium text-l1">夜间免打扰</div>
                <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-l3">
                  23:00–08:00 暂停主动推送（你在飞书里发消息照常回；桌宠勿扰时同步静音）
                </p>
              </div>
              <div className="flex min-w-0 max-w-full items-center justify-end">
                <Toggle
                  checked={cfg?.quietNight ?? false}
                  onChange={(v) => void updatePrefs(cfg?.notifyMilestones ?? true, v)}
                  label="夜间免打扰"
                />
              </div>
            </div>
          </>
        )}
      </div>

      <details className="group mt-2 px-0.5 text-xs">
        <summary className="-ml-1 inline-flex cursor-pointer list-none items-center gap-1 text-l4 hover:text-l2 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-90" />
          第一次怎么设置
        </summary>
        <p className="mt-1.5 max-w-2xl leading-5 text-l3">
          飞书开放平台建企业自建应用、加「机器人」能力 →「权限管理 → 批量导入/导出权限」粘贴下方权限 JSON 开通消息权限 →
          把 App ID / Secret 填到上面并打开，等「已连上」→ 回飞书后台「事件与回调」，事件与回调都选长连接，加「接收消息」事件和「卡片回传交互」回调（保存长连接时要检查已连上）→
          创建版本并发布 → 点「绑定」，绑好后可点「发测试卡片」验证收发闭环。详细步骤见说明书「在手机上用项目助手（飞书）」。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={paneOutlineButtonClass}
            onClick={() =>
              void copyText(
                FEISHU_PERMISSION_JSON,
                "已复制权限配置 JSON，去飞书后台「权限管理 → 批量导入/导出权限」粘贴即可",
              )
            }
          >
            复制权限配置 JSON
          </button>
          <button
            type="button"
            className={paneOutlineButtonClass}
            onClick={() => void openUrl("https://open.feishu.cn/app").catch(() => {})}
          >
            打开飞书开发者后台
          </button>
        </div>
      </details>
    </div>
  );
}
