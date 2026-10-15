import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import {
  Checkbox,
  fieldClass,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "../toast";
import { useAppStore, type AppSettings } from "../store";
import {
  FEEDBACK_EMAIL,
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_KINDS,
  FEEDBACK_TEMPLATES,
  WEBMAIL_TARGETS,
  feedbackBody,
  feedbackEnvLine,
  feedbackImageNote,
  feedbackMailto,
  feedbackPayload,
  feedbackAutoSection,
  feedbackSubject,
  stripUnfilledTemplate,
  mailtoTooLong,
  webmailBody,
  type FeedbackEnv,
  type FeedbackImage,
  type FeedbackKind,
} from "../feedback";

/**
 * 「反馈与提需求」表单弹层。三通道（src/feedback.ts / 后端 feedback.rs）：
 * - 公司端点已配置：点「发送」后台直发，全程不出应用；
 * - 用户配置了邮箱直发（SMTP）：用自己的邮箱账号从应用内发送，截图作为真实附件；
 * - 都没有：回落 mailto——表单照填，点「打开邮件发送」调系统邮件应用（内容全预填）。
 * 通道按 端点 > 邮箱直发 > mailto 自动选择；「邮箱直发设置」视图里配置
 * （授权码存 0600 keys.json，走 feedback.rs 的 set_feedback_smtp_secret，绝不回显）。
 * 各通道都有「复制全文」（正文结构一致，粘贴到任意渠道格式不散）。
 * 入口两处：顶栏帮助菜单「反馈与提需求」、设置 → 关于「反馈与提需求」。
 */

/** 常见邮箱预设：QQ/163 等需在网页版开启 SMTP 并生成授权码（不是登录密码） */
const SMTP_PROVIDERS: {
  id: string;
  label: string;
  host: string;
  port: number;
  tls: string;
  hint: string;
}[] = [
  {
    id: "qq",
    label: "QQ 邮箱",
    host: "smtp.qq.com",
    port: 465,
    tls: "tls",
    hint: "网页版设置 → 账号 → 开启 SMTP 服务并生成授权码（不是 QQ 密码）",
  },
  {
    id: "163",
    label: "163 邮箱",
    host: "smtp.163.com",
    port: 465,
    tls: "tls",
    hint: "网页版设置 → POP3/SMTP/IMAP → 开启 SMTP 并获取授权码",
  },
  {
    id: "126",
    label: "126 邮箱",
    host: "smtp.126.com",
    port: 465,
    tls: "tls",
    hint: "同 163：网页版设置里开启 SMTP 并获取授权码",
  },
  {
    id: "gmail",
    label: "Gmail",
    host: "smtp.gmail.com",
    port: 465,
    tls: "tls",
    hint: "需先开启两步验证，再生成「应用专用密码」",
  },
  {
    id: "outlook",
    label: "Outlook",
    host: "smtp.office365.com",
    port: 587,
    tls: "starttls",
    hint: "使用 Microsoft 账户的应用密码",
  },
  {
    id: "custom",
    label: "自定义",
    host: "",
    port: 465,
    tls: "tls",
    hint: "填服务器地址与端口（587 自动走 STARTTLS，其余端口走 TLS）",
  },
];
export default function FeedbackModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>("feature");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [contact, setContact] = useState("");
  const [includeEnv, setIncludeEnv] = useState(true);
  const [env, setEnv] = useState<FeedbackEnv>({});
  // undefined = 还没问到（加载中）；null = 端点未配置（mailto 回落）
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // 最近错误日志摘录（后端已脱敏、≤5 条；与「附环境」勾选同进退）。
  // 三态：undefined=还在问，null=本次运行确无错误，string=有日志
  const [errorLog, setErrorLog] = useState<string | null | undefined>(
    undefined,
  );
  // 截图附件：端点通道随表单直传；邮件通道发送时落盘（mailto 带不了附件）
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 邮件通道发送后截图所在目录（正文已注明；这里给「打开文件夹」）
  const [savedImageDir, setSavedImageDir] = useState<string | null>(null);
  // 邮箱直发（第三通道）：配置视图与草稿
  const [view, setView] = useState<"form" | "smtp">("form");
  // 网页邮箱快捷条：默认收起，底部「网页邮箱发送」按钮展开（保持表单干净）
  const [webmailOpen, setWebmailOpen] = useState(false);
  // 「查看将发送的内容」预览开关：展示自动附带段的逐字内容（透明感）
  const [autoPreviewOpen, setAutoPreviewOpen] = useState(false);
  const [smtpProviderId, setSmtpProviderId] = useState("qq");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [smtpSecret, setSmtpSecret] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const smtpConfig = useAppStore((s) => s.settings?.feedbackSmtp ?? null);
  const updateSettings = useAppStore((s) => s.updateSettings);

  // 进配置视图时按既有配置回填草稿（provider 按 host 匹配，匹配不上落自定义；
  // 授权码永不回填）。不回填时用户只想换授权码也会被逼重输邮箱，还容易没注意
  // provider 芯片已重置回 QQ，保存出「合法但错误」的配置、发送时才炸。
  useEffect(() => {
    if (!open || view !== "smtp" || !smtpConfig) return;
    setSmtpFrom(smtpConfig.from);
    const known = SMTP_PROVIDERS.find(
      (p) => p.id !== "custom" && p.host === smtpConfig.host,
    );
    if (known) {
      setSmtpProviderId(known.id);
    } else {
      setSmtpProviderId("custom");
      setSmtpHost(smtpConfig.host);
      setSmtpPort(String(smtpConfig.port));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    setView("form");
    if (!detail.trim()) setDetail(FEEDBACK_TEMPLATES[kind] ?? "");
    // 每次打开重取通道与环境：端点可能在版本更新后配上，版本号随构建变
    setEndpoint(undefined);
    invoke<string | null>("feedback_endpoint")
      .then(setEndpoint)
      .catch(() => setEndpoint(null));
    setEnv({});
    setSavedImageDir(null);
    getVersion()
      .then((v) => setEnv((e) => ({ ...e, version: v })))
      .catch(() => {});
    invoke<{ os: string; arch: string; channel: string }>("build_info")
      .then((b) =>
        setEnv((e) => ({ ...e, os: b.os, arch: b.arch, channel: b.channel })),
      )
    invoke<string | null>("feedback_error_log")
      .then(setErrorLog)
      .catch(() => setErrorLog(null));
  }, [open]);

  const kindHint = FEEDBACK_KINDS.find((k) => k.id === kind)?.hint ?? "";
  const envLine = includeEnv ? feedbackEnvLine(env) : "";
  // 勾「附环境」时连最近错误日志一起带上（body/mailto/webmail 共用）
  const attachedErrorLog = includeEnv ? (errorLog ?? null) : null;
  // 模板原样未填不算已填：剔除空模板行后判定，出站也用同一份
  const detailFilled = stripUnfilledTemplate(detail.trim());
  const ready = title.trim().length > 0 && detailFilled.length > 0;
  const body = feedbackBody({ kind, title, detail: detailFilled, contact, envLine, errorLog: attachedErrorLog });

  /** 加图：限 3 张、单张 ≤2MB（粘贴与选择同一条路）；超限就地提示不静默丢 */
  const addImageFiles = (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    let accepted = 0;
    for (const f of pics) {
      if (images.length + accepted >= FEEDBACK_IMAGE_MAX_COUNT) {
        toast(`最多 ${FEEDBACK_IMAGE_MAX_COUNT} 张截图`, "warning");
        break;
      }
      if (f.size > FEEDBACK_IMAGE_MAX_BYTES) {
        toast(`「${f.name}」超过 2MB，没加进来`, "warning");
        continue;
      }
      accepted += 1;
      const reader = new FileReader();
      reader.onload = () => {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(String(reader.result ?? ""));
        if (!m) return;
        setImages((cur) =>
          cur.length >= FEEDBACK_IMAGE_MAX_COUNT ||
            cur.some((x) => x.name === f.name && x.data === m[2])
            ? cur
            : [...cur, { name: f.name, mime: m[1], data: m[2] }],
        );
      };
      reader.readAsDataURL(f);
    }
  };

  /** 端点通道：后台直发（截图随 JSON 直传）。「不附环境」勾选同样生效。
   *  失败不关层，提示改走复制/邮件；成功清草稿再关层（组件常驻，防误重发）。 */
  const sendToEndpoint = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      const payload = feedbackPayload({
        kind,
        title,
        detail: detailFilled,
        contact,
        env: includeEnv ? env : {},
        errorLog: attachedErrorLog,
        images,
      });
      await invoke("submit_feedback", { ...payload });
      toast("已发送，谢谢你的反馈");
      setTitle("");
      setDetail("");
      setContact("");
      setImages([]);
      setSavedImageDir(null);
      onClose();
    } catch (e) {
      toast(`发送失败：${String(e)}。可点「复制全文」改走邮件`, "warning");
    } finally {
      setSending(false);
    }
  };

  /** mailto 通道：表单在 Mesa 里填好，系统邮件应用里只剩点发送。
   *  mailto 协议带不了附件——截图先落盘（save_feedback_images），正文注明目录，
   *  界面给「打开文件夹」让用户在邮件应用里手动添加。 */
  const sendViaMail = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      await sendViaMailInner();
    } finally {
      setSending(false);
    }
  };
  const sendViaMailInner = async () => {
    let finalBody = body;
    if (images.length > 0) {
      try {
        const dir = await invoke<string>("save_feedback_images", { images });
        finalBody += `\n\n${feedbackImageNote(dir, images.length)}`;
        setSavedImageDir(dir);
      } catch (e) {
        toast(`截图保存失败（${String(e)}），本次只发文字`, "warning");
      }
    }
    const url = feedbackMailto(feedbackSubject(kind, title), finalBody);
    if (mailtoTooLong(url)) {
      toast("内容较长，邮件应用可能截断；建议用「复制全文」后粘贴发送", "warning");
    }
    try {
      await openUrl(url);
      toast("已打开邮件应用，内容已填好，发送即完成反馈");
    } catch {
      toast("打不开邮件应用；可点「复制全文」手动寄送", "warning");
    }
  };

  /** 通道兜底：主题 + 正文整体复制，粘贴到任意渠道（邮件/Issues/微信） */
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(
        `${feedbackSubject(kind, title)}\n\n${body}`,
      );
      toast("已复制全文，可粘贴到任意渠道");
    } catch {
      toast("复制失败", "warning");
    }
  };

  /** 网页邮箱快捷通道：正文先复制（同一手势内，覆盖 163 无参数与超长截断两种
   *  情形），再开对应邮箱的写信深链——浏览器里已登录就能直接发，零配置。 */
  const sendViaWebmail = async (target: (typeof WEBMAIL_TARGETS)[number]) => {
    if (!ready) return;
    const subject = feedbackSubject(kind, title);
    const clipped = webmailBody(body);
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
    } catch {
      // 复制失败不拦：深链本身已带正文（163 提示改手工粘贴）
    }
    const url = target.composeUrl(FEEDBACK_EMAIL, subject, clipped);
    try {
      await openUrl(url);
      toast(
        target.carriesBody
          ? "已打开网页邮箱，正文已预填（剪贴板也有全文），发送即完成反馈"
          : `已打开${target.label}并复制全文，粘贴到写信里发送`,
      );
    } catch {
      toast("浏览器没打开，稍后再试", "warning");
    }
  };

  /** 邮箱直发（第三通道）：用户自己的 SMTP 账号从应用内发出，截图为真实附件 */
  const sendViaSmtp = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      await invoke("send_feedback_smtp", {
        subject: feedbackSubject(kind, title),
        body,
        images: images.length ? images : null,
      });
      toast(`已用 ${smtpConfig?.from ?? "邮箱"} 发送，谢谢你的反馈`);
      setTitle("");
      setDetail("");
      setContact("");
      setImages([]);
      setSavedImageDir(null);
      onClose();
    } catch (e) {
      toast(`发送失败：${String(e)}`, "warning");
    } finally {
      setSending(false);
    }
  };

  /** 保存邮箱直发配置：授权码进 keys.json（0600），配置进 settings。
   *  换邮箱或换服务器时授权码必须重填——SMTP 登录名就是发件邮箱，旧码必炸 535。 */
  const saveSmtp = async () => {
    const preset = SMTP_PROVIDERS.find((p) => p.id === smtpProviderId);
    if (!preset) return;
    const host = preset.id === "custom" ? smtpHost.trim() : preset.host;
    const port = preset.id === "custom" ? Number(smtpPort) : preset.port;
    const from = smtpFrom.trim();
    if (!host || !port) {
      toast("自定义服务器地址或端口没填全", "warning");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("端口要在 1–65535 之间", "warning");
      return;
    }
    if (!from.includes("@")) {
      toast("发件邮箱格式不对", "warning");
      return;
    }
    // 换了账号（from/host）旧授权码一定失效；只有完全没动账号才允许留空沿用
    const changedAccount =
      !!smtpConfig && (smtpConfig.from !== from || smtpConfig.host !== host);
    if (!smtpSecret.trim() && (!smtpConfig || changedAccount)) {
      toast(
        changedAccount ? "换了邮箱或服务器，授权码要重新填" : "授权码还没填",
        "warning",
      );
      return;
    }
    // 授权码形状防呆：6–64 位可打印 ASCII、不含空白。整段网页文案混进来
    // （含中文/空格/超长）当场拦下——2026-10-12 实证：221 字符的说明文字存进
    // 去后发送端才报 535，用户无从知道原因
    if (smtpSecret.trim() && !/^[\x21-\x7e]{6,64}$/.test(smtpSecret.trim())) {
      toast(
        "这不像授权码（QQ/163 是 16 位字母数字）——请确认只复制了授权码本身，别带说明文字或空格",
        "warning",
      );
      return;
    }
    // 自定义按端口推导 TLS 模式：587 是 STARTTLS 的事实标准，其余按隐式 TLS
    const tls =
      preset.id === "custom" && port === 587 ? "starttls" : preset.tls;
    setSmtpSaving(true);
    try {
      if (smtpSecret.trim()) {
        await invoke("set_feedback_smtp_secret", { secret: smtpSecret.trim() });
      }
      await updateSettings({
        feedbackSmtp: {
          provider: preset.label,
          host,
          port,
          tls,
          from,
        },
      });
      setSmtpSecret("");
      setView("form");
      toast(`邮箱直发已配置：${from}`);
    } catch (e) {
      toast(`保存失败：${String(e)}`, "warning");
    } finally {
      setSmtpSaving(false);
    }
  };

  /** 测试连接：真实「连接 + TLS + 授权码认证」，不发信。通过即可放心发送；
   *  失败文案带服务商与原始错误（535 = 授权码问题）。 */
  const testSmtp = async () => {
    if (smtpTesting) return;
    setSmtpTesting(true);
    try {
      await invoke("test_feedback_smtp");
      toast("连接与授权验证通过，可以直接发送");
    } catch (e) {
      toast(`测试未通过：${String(e)}`, "warning");
    } finally {
      setSmtpTesting(false);
    }
  };

  /** 清除邮箱直发配置（回到 mailto 通道）。settings 侧走专用清除命令：
   *  update_settings 的 Option 合并里 null 等价于字段缺失，清不掉 */
  const clearSmtp = async () => {
    setSmtpSaving(true);
    try {
      await invoke("clear_feedback_smtp_secret");
      const s = await invoke<AppSettings>("clear_feedback_smtp_config");
      useAppStore.setState({ settings: s });
      toast("已清除邮箱直发，回到邮件应用通道");
    } catch (e) {
      toast(`清除失败：${String(e)}`, "warning");
    } finally {
      setSmtpSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view === "smtp" ? "邮箱直发设置" : "反馈与提需求"}
      description={
        view === "smtp"
          ? "配置自己的邮箱后，反馈从 Mesa 里直接发出（截图作为真实附件）；授权码只存本机（0600）、绝不回显。"
          : undefined
      }
      footer={
        view === "smtp" ? (
          <>
            <button
              type="button"
              className={secondaryActionClass}
              onClick={() => setView("form")}
            >
              取消
            </button>
            {smtpConfig && (
              <button
                type="button"
                className={secondaryActionClass}
                disabled={smtpSaving}
                onClick={() => void clearSmtp()}
              >
                清除配置
              </button>
            )}
            {!smtpConfig && (
              <button
                type="button"
                className={secondaryActionClass}
                disabled={smtpSaving}
                onClick={() => void clearSmtp()}
                title="保存中断可能留下已写入的授权码；这里一并清掉（幂等）"
              >
                清除残留授权码
              </button>
            )}
            {smtpConfig && (
              <button
                type="button"
                className={secondaryActionClass}
                disabled={smtpTesting || smtpSaving}
                onClick={() => void testSmtp()}
                title="用已保存的配置与授权码做真实连接 + TLS + 认证（不发信）；改了草稿先保存再测"
              >
                {smtpTesting ? "测试中…" : "测试连接"}
              </button>
            )}
            <button
              type="button"
              className={primaryActionClass}
              disabled={smtpSaving}
              onClick={() => void saveSmtp()}
            >
              {smtpSaving ? "保存中…" : "保存并返回"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={secondaryActionClass} onClick={() => void copyAll()}>
              复制全文
            </button>
            <button
              type="button"
              className={secondaryActionClass}
              aria-expanded={webmailOpen}
              onClick={() => setWebmailOpen((v) => !v)}
            >
              网页邮箱
            </button>
            {(endpoint === null || smtpConfig) && (
              <button
                type="button"
                className={secondaryActionClass}
                onClick={() => setView("smtp")}
              >
                {smtpConfig ? "邮箱设置" : "邮箱直发"}
              </button>
            )}
            {endpoint !== null ? (
              <button
                type="button"
                className={primaryActionClass}
                disabled={!ready || sending}
                onClick={() => void sendToEndpoint()}
              >
                {sending ? "发送中…" : "发送"}
              </button>
            ) : smtpConfig ? (
              <button
                type="button"
                className={primaryActionClass}
                disabled={!ready || sending || endpoint === undefined}
                onClick={() => void sendViaSmtp()}
              >
                {sending ? "发送中…" : "发送"}
              </button>
            ) : (
              <button
                type="button"
                className={primaryActionClass}
                disabled={!ready || endpoint === undefined || sending}
                onClick={() => void sendViaMail()}
              >
                {sending ? "准备中…" : "打开邮件发送"}
              </button>
            )}
          </>
        )
      }
    >
      {view === "smtp" ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-l3">邮箱服务商</div>
            <div className="flex flex-wrap gap-1.5">
              {SMTP_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={smtpProviderId === p.id}
                  onClick={() => setSmtpProviderId(p.id)}
                  className={`h-7 rounded-md border px-2.5 text-xs transition-colors ${
                    smtpProviderId === p.id
                      ? "border-field bg-seg-sel font-medium text-l1"
                      : "border-field bg-strip text-l2 hover:bg-hover hover:text-l1"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {smtpProviderId === "custom" && (
            <div className="grid grid-cols-[1fr_7rem] gap-2">
              <div>
                <div className="mb-1 text-xs text-l3">SMTP 服务器</div>
                <input
                  className={fieldClass}
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.example.com"
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-l3">端口</div>
                <input
                  className={fieldClass}
                  value={smtpPort}
                  inputMode="numeric"
                  onChange={(e) => setSmtpPort(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 text-xs text-l3">发件邮箱</div>
            <input
              className={fieldClass}
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-l3">授权码</div>
            <input
              type="password"
              autoComplete="new-password"
              className={fieldClass}
              value={smtpSecret}
              onChange={(e) => setSmtpSecret(e.target.value)}
              placeholder={
                smtpConfig
                  ? "已配置过可留空；换邮箱 / 服务器需重填"
                  : "在邮箱设置里生成的授权码"
              }
            />
            <p className="mt-1.5 text-micro leading-4 text-l3">
              {SMTP_PROVIDERS.find((p) => p.id === smtpProviderId)?.hint}。
              授权码只存本机（0600 文件），界面永不回显。
            </p>
          </div>
        </div>
      ) : (
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-xs text-l3">类型</div>
          <div className="flex flex-wrap gap-1.5">
            {FEEDBACK_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => {
                  // 换类型 = 换脚手架：详情还是空的或仍是上一个模板的原样，
                  // 就替换为新模板；用户已写过字则一字不动
                  const tpl = FEEDBACK_TEMPLATES[kind] ?? "";
                  const next = FEEDBACK_TEMPLATES[k.id] ?? "";
                  if (!detail.trim() || detail === tpl) setDetail(next);
                  setKind(k.id);
                }}
                aria-pressed={kind === k.id}
                className={`h-7 rounded-md border px-2.5 text-xs transition-colors ${
                  kind === k.id
                    ? "border-field bg-seg-sel font-medium text-l1"
                    : "border-field bg-strip text-l2 hover:bg-hover hover:text-l1"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-l3">
            标题<span className="ml-1.5 text-l3">一句话说清</span>
          </div>
          <input
            className={fieldClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：文献雷达能按作者订阅吗"
            maxLength={80}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-l3">详情</div>
          <textarea
            className={`${fieldClass} min-h-28 resize-y`}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onPaste={(e) => {
              // 截图直贴（有文件才拦截，纯文本粘贴不受影响）
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length) {
                e.preventDefault();
                addImageFiles(files);
              }
            }}
            placeholder={kindHint}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-l3">
            截图<span className="ml-1.5 text-l3">选填，最多 3 张、单张 ≤2MB；截图可直接粘贴到详情框</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {images.map((img, i) => (
              <span
                key={`${img.name}-${i}`}
                className="flex h-7 max-w-full items-center gap-1.5 rounded-md border border-field bg-strip px-2 text-micro text-l2"
                title={img.name}
              >
                <span className="min-w-0 truncate">{img.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${img.name}`}
                  className="shrink-0 text-l3 hover:text-l1"
                  onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className={secondaryActionClass}
              onClick={() => fileInputRef.current?.click()}
            >
              添加截图
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addImageFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {savedImageDir && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-l3">
              <span className="min-w-0">截图已存到 {savedImageDir}，请在邮件里添加为附件</span>
              <button
                type="button"
                className="h-6 shrink-0 rounded-md border border-field bg-strip px-2 text-micro text-l2 hover:bg-hover hover:text-l1"
                onClick={() => void openPath(savedImageDir)}
              >
                打开文件夹
              </button>
            </p>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs text-l3">
            联系方式<span className="ml-1.5 text-l3">选填，便于追问</span>
          </div>
          <input
            className={fieldClass}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="邮箱或其他联系方式"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Checkbox
              checked={includeEnv}
              onChange={setIncludeEnv}
              label="附版本、环境与最近错误日志"
            />
            <button
              type="button"
              aria-expanded={autoPreviewOpen}
              onClick={() => setAutoPreviewOpen((v) => !v)}
              className="h-6 shrink-0 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
            >
              {autoPreviewOpen ? "收起" : "查看内容"}
            </button>
          </div>
          {autoPreviewOpen && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-field ccode-well p-2 font-mono text-micro leading-4 text-l2">
              {feedbackAutoSection(envLine, attachedErrorLog) ||
                "（未勾选——不会附加任何版本环境与错误日志）"}
            </pre>
          )}
        </div>
        {/* 端点通道截图原生支持，无需提示；邮件/网页通道带不了附件，一句话点出直发。
            -mt/-mb 抵消 space-y 与 footer 的 mt-5：细线紧贴上下内容，不再撑出一块 */}
        {endpoint === null && (
          <div className="-mt-2 -mb-3 border-t border-hairline pt-1.5">
            <p className="text-micro leading-4 text-l3">
              带截图可用「邮箱直发」——应用内直接发送、截图作为附件。
            </p>
          </div>
        )}
        {webmailOpen && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline pt-3">
            <span
              className="shrink-0 text-xs text-l3"
              title="QQ/163 无带参写信链接：只打开邮箱页，正文已复制、粘贴即发"
            >
              选你的邮箱
            </span>
            {WEBMAIL_TARGETS.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={!ready}
                onClick={() => {
                  setWebmailOpen(false);
                  void sendViaWebmail(t);
                }}
                className="h-7 rounded-md border border-field bg-strip px-2.5 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-40"
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
    </Modal>
  );
}
