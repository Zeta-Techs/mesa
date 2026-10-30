import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Bug,
  CircleHelp,
  FileArchive,
  ImagePlus,
  Lightbulb,
  MessageSquare,
  X,
} from "lucide-react";
import { Modal } from "./Modal";
import {
  Checkbox,
  InlineNotice,
  NoticeBar,
  SegTabs,
  fieldClass,
  primaryActionClass,
  quietActionClass,
  rowActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "../toast";
import { useAppStore, type AppSettings } from "../store";
import { collectFrontendDiagnostics } from "../diagnostics";
import { revealFolderLabel } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import {
  FEEDBACK_CHANNELS,
  FEEDBACK_CHANNEL_KEY,
  FEEDBACK_EMAIL,
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_KINDS,
  FEEDBACK_TEMPLATES,
  FEEDBACK_WEBMAIL_KEY,
  WEBMAIL_TARGETS,
  channelCarriesAttachments,
  feedbackAutoSection,
  feedbackBody,
  feedbackDiagnosticsNote,
  feedbackEnvLine,
  feedbackImageNote,
  feedbackImageSrc,
  feedbackMailto,
  feedbackPayload,
  feedbackSubject,
  initialFeedbackChannel,
  initialWebmailTarget,
  mailtoTooLong,
  stripUnfilledTemplate,
  webmailBody,
  type FeedbackChannel,
  type FeedbackEnv,
  type FeedbackImage,
  type FeedbackKind,
} from "../feedback";
import type { MismatchReport } from "../chat-mismatch";

/**
 * 「反馈与提需求」表单弹层（src/feedback.ts / 后端 feedback.rs）。
 * - 公司端点已配置：点「发送」后台直发，全程不出应用，不给发送方式选择；
 * - 端点未配置：表单底部「发送方式」由用户选——邮件应用（mailto）/ 网页邮箱 / 邮箱直发
 *   （用户自己的 SMTP，截图与诊断包是真实附件）。选择记在本机，下次默认同一种。
 * 附件：截图（粘贴或选择，≤3 张 ≤2MB）+ 诊断包（表单里现导出，或从「诊断与日志」带进来）。
 * 邮件应用 / 网页邮箱带不了附件——发送前落盘到下载文件夹、正文注明，交接提示里给打开入口。
 * 「邮箱直发设置」是同一弹层的第二视图（授权码存 0600 keys.json，绝不回显）。
 * 入口两处：顶栏帮助菜单「反馈与提需求」（含诊断弹窗「附到反馈」）、设置 → 关于；
 * 另有聊天层「和终端对不上」直接带着标题和两边对照打开（mismatch，chat-mismatch.ts）。
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

const KIND_ICONS: Record<FeedbackKind, typeof Bug> = {
  feature: Lightbulb,
  bug: Bug,
  question: CircleHelp,
  other: MessageSquare,
};

/** 芯片按钮（类型 / 服务商 / 网页邮箱）：选中 seg-sel，未选 strip */
const chipClass = (selected: boolean) =>
  `inline-flex h-7 items-center gap-1.5 rounded-md border border-field px-2.5 text-xs transition-colors ${
    selected
      ? "bg-seg-sel font-medium text-l1"
      : "bg-strip text-l2 hover:bg-hover hover:text-l1"
  }`;

const labelClass = "mb-1 block text-xs text-l3";
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等写不进去：只是下次不记得，不影响本次
  }
}

/** 交给邮件应用 / 网页邮箱之后的提示：发没发出去 Mesa 不知道，草稿留着由用户清 */
type Handoff = {
  /** 交接提示的结果句 */
  headline: string;
  /** 截图落盘目录（有截图时） */
  imageDir: string | null;
  /** 诊断包路径（有诊断包时） */
  diagnostics: string | null;
};

export default function FeedbackModal({
  open,
  onClose,
  attachDiagnostics = null,
  mismatch = null,
}: {
  open: boolean;
  onClose: () => void;
  /** 从「诊断与日志」带进来的诊断包路径：打开时挂到附件上 */
  attachDiagnostics?: string | null;
  /** 聊天层「和终端对不上」带进来的：类型切缺陷、填标题和脚手架，两边对照另起一个勾选 */
  mismatch?: MismatchReport | null;
}) {
  const [kind, setKind] = useState<FeedbackKind>("feature");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [contact, setContact] = useState("");
  const [includeEnv, setIncludeEnv] = useState(true);
  const [env, setEnv] = useState<FeedbackEnv>({});
  // undefined = 还没问到（加载中）；null = 端点未配置（用户选发送方式）
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // 最近错误日志摘录（后端已脱敏、≤5 条；与「附环境」勾选同进退）。
  // 三态：undefined=还在问，null=本次运行确无错误，string=有日志
  const [errorLog, setErrorLog] = useState<string | null | undefined>(undefined);
  // 「和终端对不上」的两边对照（后端已脱敏）：单独勾选、单独预览，与「附环境」不同进退
  const [chatSnapshot, setChatSnapshot] = useState<string | null>(null);
  const [includeSnapshot, setIncludeSnapshot] = useState(true);
  const [snapshotPreviewOpen, setSnapshotPreviewOpen] = useState(false);
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 诊断包附件（导出目录里的文件路径；发送时后端按白名单自读）
  const [diagPath, setDiagPath] = useState<string | null>(null);
  const [diagExporting, setDiagExporting] = useState(false);
  const smtpConfig = useAppStore((s) => s.settings?.feedbackSmtp ?? null);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [channel, setChannelState] = useState<FeedbackChannel>(() =>
    initialFeedbackChannel(readStored(FEEDBACK_CHANNEL_KEY), !!smtpConfig),
  );
  const [webmailId, setWebmailIdState] = useState(() =>
    initialWebmailTarget(readStored(FEEDBACK_WEBMAIL_KEY)),
  );
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  // 「查看将发送的内容」预览开关：展示自动附带段的逐字内容（透明感）
  const [autoPreviewOpen, setAutoPreviewOpen] = useState(false);
  // 邮箱直发设置视图与草稿
  const [view, setView] = useState<"form" | "smtp">("form");
  const [smtpProviderId, setSmtpProviderId] = useState("qq");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [smtpSecret, setSmtpSecret] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  // 测试结果就地显示（535 的排查清单很长，toast 一闪就没了）
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; text: string } | null>(null);

  const setChannel = (c: FeedbackChannel) => {
    setChannelState(c);
    writeStored(FEEDBACK_CHANNEL_KEY, c);
  };
  const setWebmailId = (id: string) => {
    setWebmailIdState(id);
    writeStored(FEEDBACK_WEBMAIL_KEY, id);
  };

  // 进配置视图时按既有配置回填草稿（provider 按 host 匹配，匹配不上落自定义；
  // 授权码永不回填）。不回填时用户只想换授权码也会被逼重输邮箱，还容易没注意
  // provider 芯片已重置回 QQ，保存出「合法但错误」的配置、发送时才炸。
  useEffect(() => {
    if (!open || view !== "smtp") return;
    setSmtpResult(null);
    setSmtpSecret("");
    if (!smtpConfig) return;
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
    // 没选过发送方式时按当下配置定默认：组件随 App 常驻，首次挂载时设置可能还没读到，
    // 已配邮箱直发的老用户会被误落到邮件应用
    if (!readStored(FEEDBACK_CHANNEL_KEY)) {
      setChannelState(initialFeedbackChannel(null, !!smtpConfig));
    }
    // 每次打开重取通道与环境：端点可能在版本更新后配上，版本号随构建变
    setEndpoint(undefined);
    invoke<string | null>("feedback_endpoint")
      .then(setEndpoint)
      .catch(() => setEndpoint(null));
    setEnv({});
    getVersion()
      .then((v) => setEnv((e) => ({ ...e, version: v })))
      .catch(() => {});
    invoke<{ os: string; arch: string; channel: string }>("build_info")
      .then((b) => setEnv((e) => ({ ...e, os: b.os, arch: b.arch, channel: b.channel })))
      .catch(() => {});
    invoke<string | null>("feedback_error_log")
      .then(setErrorLog)
      .catch(() => setErrorLog(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 从聊天层「和终端对不上」进来：换成这一份（标题、脚手架、对照都是这次的），草稿里原有的字不留
  useEffect(() => {
    if (!open || !mismatch) return;
    setHandoff(null);
    setKind("bug");
    setTitle(mismatch.title);
    setDetail(mismatch.detail);
    setChatSnapshot(mismatch.snapshot);
    setIncludeSnapshot(true);
    setSnapshotPreviewOpen(false);
  }, [open, mismatch]);

  // 从诊断弹窗「附到反馈」进来：挂上那份诊断包；报的多半是问题，类型顺手切到缺陷
  useEffect(() => {
    if (!open || !attachDiagnostics) return;
    setDiagPath(attachDiagnostics);
    setHandoff(null);
    if (kind === "feature" && (!detail.trim() || detail === FEEDBACK_TEMPLATES.feature)) {
      setDetail(FEEDBACK_TEMPLATES.bug ?? "");
      setKind("bug");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attachDiagnostics]);

  const effective: FeedbackChannel | "endpoint" = endpoint ? "endpoint" : channel;
  const webmail = WEBMAIL_TARGETS.find((t) => t.id === webmailId) ?? WEBMAIL_TARGETS[0];
  const kindHint = FEEDBACK_KINDS.find((k) => k.id === kind)?.hint ?? "";
  const envLine = includeEnv ? feedbackEnvLine(env) : "";
  // 勾「附环境」时连最近错误日志一起带上（body/mailto/webmail 共用）
  const attachedErrorLog = includeEnv ? (errorLog ?? null) : null;
  const attachedSnapshot = includeSnapshot ? chatSnapshot : null;
  // 模板原样未填不算已填：剔除空模板行后判定，出站也用同一份
  const detailFilled = stripUnfilledTemplate(detail.trim());
  const ready = title.trim().length > 0 && detailFilled.length > 0;
  const body = feedbackBody({
    kind,
    title,
    detail: detailFilled,
    contact,
    envLine,
    errorLog: attachedErrorLog,
    chatSnapshot: attachedSnapshot,
  });
  const hasAttachments = images.length > 0 || !!diagPath;
  const busy = sending || smtpSaving || smtpTesting;

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

  /** 现导出一份诊断包挂到附件上（与设置 → 诊断同一个命令，产物在下载/ccode-exports） */
  const exportDiagnostics = async () => {
    if (diagExporting) return;
    setDiagExporting(true);
    try {
      const path = await invoke<string>("export_diagnostics_bundle", {
        frontend: collectFrontendDiagnostics(),
      });
      setDiagPath(path);
    } catch (e) {
      toast(`诊断包导出失败：${String(e)}`, "error");
    } finally {
      setDiagExporting(false);
    }
  };

  /** 发出成功：清草稿再关层（组件常驻，防误重发） */
  const resetDraft = () => {
    setTitle("");
    setDetail("");
    setContact("");
    setImages([]);
    setDiagPath(null);
    setHandoff(null);
    setChatSnapshot(null);
  };

  /** 端点通道：后台直发（截图随 JSON 直传，诊断包由后端按路径读）。
   *  失败不关层，提示改走复制/邮件。 */
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
        chatSnapshot: attachedSnapshot ?? undefined,
      });
      await invoke("submit_feedback", {
        ...payload,
        chatSnapshot: payload.chatSnapshot ?? null,
        diagnostics: diagPath,
      });
      toast("已发送，谢谢你的反馈");
      resetDraft();
      onClose();
    } catch (e) {
      toast(`发送失败：${String(e)}。可点「复制全文」改走邮件`, "warning");
    } finally {
      setSending(false);
    }
  };

  /** 邮箱直发：用户自己的 SMTP 账号从应用内发出，截图与诊断包为真实附件 */
  const sendViaSmtp = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      await invoke("send_feedback_smtp", {
        subject: feedbackSubject(kind, title),
        body,
        images: images.length ? images : null,
        diagnostics: diagPath,
      });
      toast(`已用 ${smtpConfig?.from ?? "邮箱"} 发送，谢谢你的反馈`);
      resetDraft();
      onClose();
    } catch (e) {
      toast(`发送失败：${String(e)}`, "warning");
    } finally {
      setSending(false);
    }
  };

  /** 邮件类通道带不了附件：截图落盘、诊断包本就在下载文件夹，正文注明位置 */
  const bodyWithAttachmentNotes = async (): Promise<{
    text: string;
    imageDir: string | null;
  }> => {
    const notes: string[] = [];
    let imageDir: string | null = null;
    if (images.length > 0) {
      try {
        imageDir = await invoke<string>("save_feedback_images", { images });
        notes.push(feedbackImageNote(imageDir, images.length));
      } catch (e) {
        toast(`截图保存失败（${String(e)}），本次只发文字`, "warning");
      }
    }
    if (diagPath) notes.push(feedbackDiagnosticsNote(diagPath));
    return { text: notes.length ? `${body}\n\n${notes.join("\n")}` : body, imageDir };
  };

  /** 邮件应用通道：表单在 Mesa 里填好，系统邮件应用里只剩点发送 */
  const sendViaMail = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      const { text, imageDir } = await bodyWithAttachmentNotes();
      const url = feedbackMailto(feedbackSubject(kind, title), text);
      if (mailtoTooLong(url)) {
        toast("内容较长，邮件应用可能截断；建议用「复制全文」后粘贴发送", "warning");
      }
      try {
        await openUrl(url);
        setHandoff({
          headline: "已在邮件应用里打开，点发送就完成了",
          imageDir,
          diagnostics: diagPath,
        });
      } catch {
        toast("打不开邮件应用；可点「复制全文」手动寄送，或换个发送方式", "warning");
      }
    } finally {
      setSending(false);
    }
  };

  /** 网页邮箱：正文先复制（同一手势内，覆盖 QQ/163 无带参链接与超长截断），
   *  再开写信深链——浏览器里已登录就能直接发，零配置。 */
  const sendViaWebmail = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      const { text, imageDir } = await bodyWithAttachmentNotes();
      const subject = feedbackSubject(kind, title);
      try {
        await navigator.clipboard.writeText(`${subject}\n\n${text}`);
      } catch {
        // 复制失败不拦：深链本身已带正文（QQ/163 时提示改手工输入）
      }
      try {
        await openUrl(webmail.composeUrl(FEEDBACK_EMAIL, subject, webmailBody(text)));
        setHandoff({
          headline: webmail.carriesBody
            ? `已在浏览器里打开 ${webmail.label}，正文已填好，点发送就完成了`
            : `已在浏览器里打开 ${webmail.label}，写信时粘贴正文（已复制）再发送`,
          imageDir,
          diagnostics: diagPath,
        });
      } catch {
        toast("浏览器没打开，稍后再试", "warning");
      }
    } finally {
      setSending(false);
    }
  };

  /** 兜底：主题 + 正文整体复制，粘贴到任意渠道（邮件/Issues/微信） */
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(`${feedbackSubject(kind, title)}\n\n${body}`);
      toast("已复制全文，可粘贴到任意渠道");
    } catch {
      toast("复制失败", "warning");
    }
  };

  /** 保存邮箱直发配置并当场测一次连接：授权码进 keys.json（0600），配置进 settings。
   *  换邮箱或换服务器时授权码必须重填——SMTP 登录名就是发件邮箱，旧码必炸 535。 */
  const saveSmtp = async () => {
    const preset = SMTP_PROVIDERS.find((p) => p.id === smtpProviderId);
    if (!preset) return;
    const host = preset.id === "custom" ? smtpHost.trim() : preset.host;
    const port = preset.id === "custom" ? Number(smtpPort) : preset.port;
    const from = smtpFrom.trim();
    const secret = smtpSecret.trim();
    const fail = (text: string) => setSmtpResult({ ok: false, text });
    if (!host || !port) return fail("自定义服务器的地址或端口没填全");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail("端口要在 1–65535 之间");
    if (!from.includes("@")) return fail("发件邮箱格式不对");
    // 换了账号（from/host）旧授权码一定失效；只有完全没动账号才允许留空沿用
    const changedAccount = !!smtpConfig && (smtpConfig.from !== from || smtpConfig.host !== host);
    if (!secret && (!smtpConfig || changedAccount)) {
      return fail(changedAccount ? "换了邮箱或服务器，授权码要重新填" : "授权码还没填");
    }
    // 授权码形状防呆：6–64 位可打印 ASCII、不含空白。整段网页文案混进来
    // （含中文/空格/超长）当场拦下——2026-10-12 实证：221 字符的说明文字存进
    // 去后发送端才报 535，用户无从知道原因
    if (secret && !/^[\x21-\x7e]{6,64}$/.test(secret)) {
      return fail(
        "这不像授权码（QQ/163 是 16 位字母数字）。请确认只复制了授权码本身，别带说明文字或空格",
      );
    }
    // 自定义按端口推导 TLS 模式：587 是 STARTTLS 的事实标准，其余按隐式 TLS
    const tls = preset.id === "custom" && port === 587 ? "starttls" : preset.tls;
    setSmtpSaving(true);
    setSmtpResult(null);
    let secretWritten = false;
    try {
      if (secret) {
        await invoke("set_feedback_smtp_secret", { secret });
        secretWritten = true;
      }
      await updateSettings({ feedbackSmtp: { provider: preset.label, host, port, tls, from } });
    } catch (e) {
      // 首次配置时授权码写进去了、配置没存上：撤掉授权码，不留无主的残留
      if (secretWritten && !smtpConfig) {
        await invoke("clear_feedback_smtp_secret").catch(() => {});
      }
      setSmtpSaving(false);
      return fail(`保存失败：${String(e)}`);
    }
    setSmtpSecret("");
    setSmtpSaving(false);
    const ok = await testSmtp();
    if (ok) {
      setChannel("smtp");
      setView("form");
      toast(`邮箱直发已就绪：${from}`);
    }
  };

  /** 测试连接：真实「连接 + TLS + 授权码认证」，不发信。结果就地显示 */
  const testSmtp = async (): Promise<boolean> => {
    if (smtpTesting) return false;
    setSmtpTesting(true);
    setSmtpResult(null);
    try {
      await invoke("test_feedback_smtp");
      setSmtpResult({ ok: true, text: "连接与授权验证通过，可以直接发送" });
      return true;
    } catch (e) {
      setSmtpResult({ ok: false, text: `已保存，但测试没通过：${String(e)}` });
      return false;
    } finally {
      setSmtpTesting(false);
    }
  };

  /** 清除邮箱直发配置。settings 侧走专用清除命令：
   *  update_settings 的 Option 合并里 null 等价于字段缺失，清不掉 */
  const clearSmtp = async () => {
    setSmtpSaving(true);
    try {
      await invoke("clear_feedback_smtp_secret");
      const s = await invoke<AppSettings>("clear_feedback_smtp_config");
      useAppStore.setState({ settings: s });
      setSmtpFrom("");
      setSmtpResult(null);
      toast("已清除邮箱直发配置");
    } catch (e) {
      setSmtpResult({ ok: false, text: `清除失败：${String(e)}` });
    } finally {
      setSmtpSaving(false);
    }
  };

  // ---------- 主按钮：随发送方式变 ----------
  let primary: { label: string; onClick: () => void; disabled: boolean };
  if (effective === "endpoint") {
    primary = { label: sending ? "发送中…" : "发送", onClick: () => void sendToEndpoint(), disabled: !ready || sending };
  } else if (effective === "smtp") {
    primary = smtpConfig
      ? {
          label: sending ? "发送中…" : "发送",
          onClick: () => void sendViaSmtp(),
          disabled: !ready || sending || endpoint === undefined,
        }
      : { label: "配置邮箱…", onClick: () => setView("smtp"), disabled: false };
  } else if (effective === "webmail") {
    primary = {
      label: sending ? "准备中…" : `打开 ${webmail.label}`,
      onClick: () => void sendViaWebmail(),
      disabled: !ready || sending || endpoint === undefined,
    };
  } else {
    primary = {
      label: sending ? "准备中…" : "打开邮件应用",
      onClick: () => void sendViaMail(),
      disabled: !ready || sending || endpoint === undefined,
    };
  }

  const smtpPreset = SMTP_PROVIDERS.find((p) => p.id === smtpProviderId);
  const channelHint = (): ReactNode => {
    if (effective === "endpoint") return "点发送直接送达开发者，截图和诊断包随附。";
    if (effective === "smtp") {
      return smtpConfig ? (
        <>
          从 <span className="text-l2">{smtpConfig.from}</span> 发出，截图和诊断包作为附件，开发者回信直达这个邮箱。
          <button
            type="button"
            onClick={() => setView("smtp")}
            className="ml-1 text-l2 underline decoration-dotted underline-offset-2 hover:text-l1"
          >
            修改
          </button>
        </>
      ) : (
        "用你自己的邮箱从 Mesa 里直接发出，截图和诊断包作为附件。先配置一次发件邮箱和授权码。"
      );
    }
    const base = FEEDBACK_CHANNELS.find((c) => c.id === effective)?.hint ?? "";
    const webmailNote =
      effective === "webmail" && !webmail.carriesBody
        ? `${webmail.label}没有带正文的写信链接：正文会先复制好，粘贴进去即可。`
        : "";
    const attachNote =
      hasAttachments && !channelCarriesAttachments(effective)
        ? "这种方式带不了附件：发送前截图和诊断包会存到下载文件夹，需要你在邮件里手动添加。"
        : "";
    return [`${base}。`, webmailNote, attachNote].filter(Boolean).join("");
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissOnBackdrop={!busy}
      title={view === "smtp" ? "邮箱直发设置" : "反馈与提需求"}
      description={
        view === "smtp"
          ? "配好后反馈从 Mesa 里直接发出，截图和诊断包作为真实附件。授权码只存本机（仅本人可读的文件），界面永不回显。"
          : "直接发给 Mesa 开发者。别贴 API 密钥或 token——诊断包已脱敏，自己复制的终端输出可能还带着。"
      }
      footer={
        view === "smtp" ? (
          <>
            <button
              type="button"
              className={`${quietActionClass} mr-auto`}
              disabled={busy}
              onClick={() => setView("form")}
            >
              返回表单
            </button>
            {smtpConfig && (
              <button
                type="button"
                className={secondaryActionClass}
                disabled={busy}
                onClick={() => void testSmtp()}
                title="用已保存的配置与授权码做真实连接 + TLS + 认证（不发信）；改了上面的内容先点保存"
              >
                {smtpTesting && !smtpSaving ? "测试中…" : "测试连接"}
              </button>
            )}
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy}
              onClick={() => void saveSmtp()}
            >
              {smtpSaving ? "保存中…" : smtpTesting ? "测试中…" : "保存并测试"}
            </button>
          </>
        ) : handoff ? (
          // 交给邮件应用 / 网页邮箱之后：提示钉在按钮正上方，按钮换成「发没发」两个决定；
          // 想重开邮箱先点「还没发，保留」回到原按钮
          <>
            <div className="basis-full">
              <NoticeBar tone="info">
                <span className="block font-medium text-l1">{handoff.headline}</span>
                {(handoff.imageDir || handoff.diagnostics) && (
                  <span className="mt-0.5 block text-l3">
                    附件需要你在邮件里手动添加：
                    {handoff.imageDir && (
                      <button
                        type="button"
                        className="ml-1 underline decoration-dotted underline-offset-2 hover:text-l1"
                        onClick={() => void openPath(handoff.imageDir as string).catch(() => {})}
                      >
                        打开截图文件夹
                      </button>
                    )}
                    {handoff.diagnostics && (
                      <button
                        type="button"
                        className="ml-2 underline decoration-dotted underline-offset-2 hover:text-l1"
                        onClick={() =>
                          void revealItemInDir(handoff.diagnostics as string).catch(() => {})
                        }
                      >
                        诊断包：{revealFolderLabel(IS_MAC, IS_WINDOWS)}
                      </button>
                    )}
                  </span>
                )}
              </NoticeBar>
            </div>
            <button
              type="button"
              className={`${quietActionClass} mr-auto`}
              onClick={() => void copyAll()}
              title="主题 + 正文一起复制，粘贴到任意渠道"
            >
              复制全文
            </button>
            <button type="button" className={secondaryActionClass} onClick={() => setHandoff(null)}>
              还没发，保留
            </button>
            {/* 刚点的「打开邮箱」随交接卸载，焦点接到这里，免得落回 body */}
            <button
              type="button"
              autoFocus
              className={primaryActionClass}
              onClick={() => {
                resetDraft();
                onClose();
              }}
            >
              已发出，清空草稿
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${quietActionClass} mr-auto`}
              onClick={() => void copyAll()}
              title="主题 + 正文一起复制，粘贴到任意渠道"
            >
              复制全文
            </button>
            <button
              type="button"
              className={primaryActionClass}
              disabled={primary.disabled}
              title={!ready ? "填好标题和详情后可发送" : undefined}
              onClick={primary.onClick}
            >
              {primary.label}
            </button>
          </>
        )
      }
      // 正文自己滚、页脚钉底：长表单下发送按钮和交接提示始终看得见。滚动条 6px 常驻占位：
      // 外扩 12px、内补 6px，正文右沿与页脚按钮对齐，滚动条落进面板内边距
      contentClassName="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] -mr-3 pr-1.5"
    >
      {view === "smtp" ? (
        <div className="space-y-3">
          <div>
            <span className={labelClass}>邮箱服务商</span>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {SMTP_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={smtpProviderId === p.id}
                  onClick={() => setSmtpProviderId(p.id)}
                  className={chipClass(smtpProviderId === p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {smtpProviderId === "custom" && (
            <div className="grid grid-cols-[1fr_7rem] gap-2">
              <label>
                <span className={labelClass}>SMTP 服务器</span>
                <input
                  className={fieldClass}
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.example.com"
                />
              </label>
              <label>
                <span className={labelClass}>端口</span>
                <input
                  className={fieldClass}
                  value={smtpPort}
                  inputMode="numeric"
                  onChange={(e) => setSmtpPort(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </label>
            </div>
          )}
          <label className="block">
            <span className={labelClass}>发件邮箱</span>
            <input
              className={fieldClass}
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className={labelClass}>授权码</span>
            <input
              type="password"
              autoComplete="new-password"
              className={fieldClass}
              value={smtpSecret}
              onChange={(e) => setSmtpSecret(e.target.value)}
              placeholder={
                smtpConfig ? "已配置过可留空；换邮箱或服务器需重填" : "在邮箱设置里生成的授权码"
              }
            />
            <span className="mt-1.5 block text-micro leading-4 text-l3">
              {smtpPreset?.hint}。授权码不是登录密码。
            </span>
          </label>
          {smtpResult && (
            <InlineNotice tone={smtpResult.ok ? "ok" : "err"}>{smtpResult.text}</InlineNotice>
          )}
          {smtpConfig && (
            <p className="text-micro text-l4">
              当前：{smtpConfig.provider} · {smtpConfig.from}
              <button
                type="button"
                disabled={busy}
                onClick={() => void clearSmtp()}
                className="ml-2 underline decoration-dotted underline-offset-2 hover:text-l2 disabled:opacity-50"
              >
                清除配置
              </button>
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3.5">
          <div>
            <span className={labelClass}>类型</span>
            {/* 全站 button { font: inherit } 会吞掉按钮上的 text-*：字号挂在容器上 */}
            <div className="flex flex-wrap gap-1.5 text-xs">
              {FEEDBACK_KINDS.map((k) => {
                const Icon = KIND_ICONS[k.id];
                return (
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
                    className={chipClass(kind === k.id)}
                  >
                    <Icon size={13} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
                    {k.label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="block">
            <span className={labelClass}>标题</span>
            <input
              className={fieldClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="一句话说清，例：文献雷达能按作者订阅吗"
              maxLength={80}
            />
          </label>
          <label className="block">
            <span className={labelClass}>详情</span>
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
          </label>

          <div>
            <span className={labelClass}>附件</span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {images.map((img, i) => (
                <span
                  key={`${img.name}-${i}`}
                  className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-field bg-inset"
                  title={img.name}
                >
                  <img src={feedbackImageSrc(img)} alt={img.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label={`移除 ${img.name}`}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-80 hover:opacity-100"
                    onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                  >
                    <X size={11} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {diagPath && (
                <span
                  className="flex h-14 max-w-56 items-center gap-2 rounded-md border border-field bg-strip pl-2.5 pr-1.5"
                  title={diagPath}
                >
                  <FileArchive size={18} strokeWidth={1.6} aria-hidden="true" className="shrink-0 text-l3" />
                  <span className="min-w-0">
                    <span className="block text-xs text-l1">诊断包</span>
                    <span className="block truncate font-mono text-micro text-l4">{baseName(diagPath)}</span>
                  </span>
                  <button
                    type="button"
                    aria-label="移除诊断包"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                    onClick={() => setDiagPath(null)}
                  >
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                </span>
              )}
              {images.length < FEEDBACK_IMAGE_MAX_COUNT && (
                <button
                  type="button"
                  className={`${rowActionClass} gap-1.5`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus size={13} strokeWidth={1.8} aria-hidden="true" />
                  截图
                </button>
              )}
              {!diagPath && (
                <button
                  type="button"
                  className={`${rowActionClass} gap-1.5`}
                  disabled={diagExporting}
                  onClick={() => void exportDiagnostics()}
                  title="导出一份脱敏诊断包并附上（系统与运行信息、最近日志；不含密钥与环境变量）"
                >
                  <FileArchive size={13} strokeWidth={1.8} aria-hidden="true" />
                  {diagExporting ? "正在导出…" : "诊断包"}
                </button>
              )}
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
            <p className="mt-1.5 text-micro leading-4 text-l4">
              {kind === "bug" && !diagPath
                ? "报缺陷时附上诊断包，定位会快很多。截图也可以直接粘贴到详情框。"
                : `截图可直接粘贴到详情框，最多 ${FEEDBACK_IMAGE_MAX_COUNT} 张、单张不超过 2MB。`}
            </p>
          </div>

          <label className="block">
            <span className={labelClass}>联系方式（选填，便于追问）</span>
            <input
              className={fieldClass}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="邮箱、微信或其他联系方式"
            />
          </label>

          {chatSnapshot && (
            <div>
              <div className="flex items-center justify-between gap-2 text-micro">
                <Checkbox
                  checked={includeSnapshot}
                  onChange={setIncludeSnapshot}
                  label={<span className="text-xs text-l2">附上聊天里显示的和终端里的内容（已去掉密钥）</span>}
                />
                <button
                  type="button"
                  aria-expanded={snapshotPreviewOpen}
                  onClick={() => setSnapshotPreviewOpen((v) => !v)}
                  className="h-6 shrink-0 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                >
                  {snapshotPreviewOpen ? "收起" : "看看会附什么"}
                </button>
              </div>
              {snapshotPreviewOpen && (
                <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md ccode-well p-2 font-mono text-micro leading-4 text-l2">
                  {chatSnapshot}
                </pre>
              )}
              <p className="mt-1 text-micro leading-4 text-l4">
                两边对照着看，最容易找到聊天哪里认错了。里面可能有你的文件名和对话内容，不想发就取消勾选。
              </p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 text-micro">
              <Checkbox
                checked={includeEnv}
                onChange={setIncludeEnv}
                label={<span className="text-xs text-l2">附上版本、系统环境与最近的错误日志</span>}
              />
              <button
                type="button"
                aria-expanded={autoPreviewOpen}
                onClick={() => setAutoPreviewOpen((v) => !v)}
                className="h-6 shrink-0 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                {autoPreviewOpen ? "收起" : "看看会附什么"}
              </button>
            </div>
            {autoPreviewOpen && (
              <pre className="mt-1.5 max-h-40 overflow-auto rounded-md ccode-well p-2 font-mono text-micro leading-4 text-l2">
                {feedbackAutoSection(envLine, attachedErrorLog, null) ||
                  "（未勾选——不会附加任何版本环境与错误日志）"}
              </pre>
            )}
          </div>

          <div className="rounded-lg ccode-well p-3">
            {endpoint === null && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-xs text-l3">发送方式</span>
                <SegTabs<FeedbackChannel>
                  className="text-xs"
                  items={FEEDBACK_CHANNELS.map((c) => ({ id: c.id, label: c.label }))}
                  value={channel}
                  onChange={(c) => {
                    setChannel(c);
                    setHandoff(null);
                  }}
                />
              </div>
            )}
            {effective === "webmail" && (
              <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
                {WEBMAIL_TARGETS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={webmailId === t.id}
                    onClick={() => setWebmailId(t.id)}
                    className={chipClass(webmailId === t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <p className="text-micro leading-4 text-l3">
              {endpoint === undefined ? "正在确认发送通道…" : channelHint()}
            </p>
            {effective !== "endpoint" && endpoint !== undefined && (
              <p className="mt-1 flex items-center gap-1 text-micro leading-4 text-l4">
                收件人 <span className="font-mono text-l3">{FEEDBACK_EMAIL}</span>
                <button
                  type="button"
                  className="ml-0.5 underline decoration-dotted underline-offset-2 hover:text-l2"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(FEEDBACK_EMAIL)
                      .then(() => toast("收件地址已复制"))
                      .catch(() => toast("复制失败", "warning"))
                  }
                >
                  复制
                </button>
              </p>
            )}
          </div>

        </div>
      )}
    </Modal>
  );
}
