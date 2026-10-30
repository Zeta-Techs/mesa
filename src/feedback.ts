/**
 * 反馈与提需求的纯逻辑：类型枚举、正文拼装、发送方式与各通道的链接/负载。
 *
 * 通道：公司端点（配置后后台直发）；未配置时用户在表单里选发送方式——邮件应用
 * （mailto，零基建、不需要 GitHub 账号）、网页邮箱、邮箱直发（自己的 SMTP）。
 * 正文结构各通道一致，同时服务于「复制全文」（粘贴到任意渠道格式不散）。
 */

/** 反馈直达邮箱（对外联系邮箱，2026-10-12 定） */
export const FEEDBACK_EMAIL = "hong.tongzhou@zetatechs.com";

export type FeedbackKind = "feature" | "bug" | "question" | "other";

export const FEEDBACK_KINDS: {
  id: FeedbackKind;
  label: string;
  /** 详情框的引导语：让用户知道这类反馈该写什么 */
  hint: string;
}[] = [
  { id: "feature", label: "功能需求", hint: "想解决什么问题、期望它怎么工作" },
  { id: "bug", label: "缺陷", hint: "做了什么、预期是什么、实际发生了什么" },
  { id: "question", label: "疑问", hint: "哪里没看明白、卡在哪一步" },
  { id: "other", label: "其他", hint: "想说什么都行" },
];

export function feedbackKindLabel(kind: FeedbackKind): string {
  return FEEDBACK_KINDS.find((k) => k.id === kind)?.label ?? "其他";
}

/** 详情填写脚手架：选类型即铺模板（缺陷 = 复现三件套、功能需求 = 问题两件套），
 *  疑问/其他保持自由文本。空模板行发送时剔除（stripUnfilledTemplate）。 */
export const FEEDBACK_TEMPLATES: Partial<Record<FeedbackKind, string>> = {
  bug: "做了什么：\n预期：\n实际：",
  feature: "想解决的问题：\n期望的做法：",
};

/** 剔除没填内容的模板行（「预期：」后面没字的整行删掉，填了原样保留） */
export function stripUnfilledTemplate(text: string): string {
  const headers = /^(做了什么|预期|实际|想解决的问题|期望的做法|哪里对不上|你当时在做什么)：\s*$/;
  return text
    .split("\n")
    .filter((line) => !headers.test(line.trim()))
    .join("\n");
}

/** 环境信息行：版本（Tauri getVersion）+ 构建信息（build_info 命令），缺哪段跳哪段 */
export interface FeedbackEnv {
  version?: string | null;
  os?: string;
  arch?: string;
  channel?: string;
}

export function feedbackEnvLine(env: FeedbackEnv): string {
  const parts: string[] = [];
  if (env.version) parts.push(`Mesa v${env.version}`);
  if (env.os) parts.push(env.os === "macos" ? "macOS" : env.os === "windows" ? "Windows" : env.os);
  if (env.arch) {
    parts.push(
      env.os === "macos" && env.arch === "aarch64"
        ? "Apple 芯片"
        : env.arch === "x86_64"
          ? "x64"
          : env.arch,
    );
  }
  if (env.channel === "dev") parts.push("开发模式");
  return parts.join(" · ");
}

/** 邮件主题：[Mesa·功能需求] 标题 —— 收件箱里一眼分流 */
export function feedbackSubject(kind: FeedbackKind, title: string): string {
  return `[Mesa·${feedbackKindLabel(kind)}] ${title.trim()}`;
}

export interface FeedbackBodyInput {
  kind: FeedbackKind;
  title: string;
  detail: string;
  /** 可选联系方式（邮箱/微信等），用户自愿填 */
  contact?: string;
  /** feedbackEnvLine 的结果；空串则不落环境段 */
  envLine?: string;
  /** 最近错误日志摘录（feedback_error_log 命令；与 envLine 同进退） */
  errorLog?: string | null;
  /** 「聊天和终端对不上」的两边对照（chat-mismatch.ts 拼、后端 feedback_chat_snapshot 脱敏）；有自己的勾选 */
  chatSnapshot?: string | null;
}

/** 「自动附带」段（含分隔标题行）：邮件正文与表单里的发送预览共用，
 *  用户看到什么就发什么，杜绝两处口径漂移 */
export function feedbackAutoSection(
  envLine?: string,
  errorLog?: string | null,
  chatSnapshot?: string | null,
): string {
  const auto: string[] = [];
  if (envLine) auto.push(envLine);
  if (errorLog) auto.push("", "最近错误日志：", errorLog);
  if (chatSnapshot) auto.push(...(auto.length ? [""] : []), chatSnapshot);
  if (!auto.length) return "";
  return ["——以下由 Mesa 自动附带——", ...auto].join("\n");
}

export function feedbackBody(input: FeedbackBodyInput): string {
  const lines: string[] = [stripUnfilledTemplate(input.detail.trim())];
  if (input.contact?.trim()) lines.push("", `联系方式：${input.contact.trim()}`);
  const auto = feedbackAutoSection(input.envLine, input.errorLog, input.chatSnapshot);
  if (auto) lines.push("", auto);
  return lines.join("\n");
}

/** mailto 通道：收件人/主题/正文全预填，邮件应用里只剩点发送 */
export function feedbackMailto(subject: string, body: string): string {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** mailto 超长保护：编码后约 1800 字符以上部分邮件客户端会截断，
 *  这种反馈改走「复制全文」更稳 */
export function mailtoTooLong(url: string): boolean {
  return url.length > 1800;
}

/** 网页邮箱快捷通道：compose 深链预填收件人/主题/正文，浏览器里已登录就能直接发——
 *  零配置，比 SMTP 和邮件客户端都省事。Gmail/Outlook 参数是官方文档化方案；
 *  QQ 与 163 没有公开的带参写信链接（QQ 的 cgi-bin/compose 已 404，「邮我」
 *  qm_share 只预填收件人且 token 需登录生成，均不可用——2026-10-12 搜证核实），
 *  只开邮箱首页，正文靠剪贴板粘贴（调用方先复制）。 */
export const WEBMAIL_TARGETS: {
  id: string;
  label: string;
  /** true = 深链会带上正文；false = 只打开邮箱首页 */
  carriesBody: boolean;
  composeUrl: (to: string, subject: string, body: string) => string;
}[] = [
  {
    id: "qq",
    label: "QQ 邮箱",
    carriesBody: false,
    composeUrl: () => "https://mail.qq.com/",
  },
  {
    id: "gmail",
    label: "Gmail",
    carriesBody: true,
    composeUrl: (to, subject, body) =>
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  },
  {
    id: "outlook",
    label: "Outlook",
    carriesBody: true,
    composeUrl: (to, subject, body) =>
      `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  },
  {
    id: "163",
    label: "163 邮箱",
    carriesBody: false,
    composeUrl: () => "https://mail.163.com/",
  },
];

/** 网页邮箱深链的正文截断保护：URL 编码后总长超 ~8000 走不进地址栏，
 *  截到 1200 字符并标注（全文已在剪贴板，粘贴即全） */
export function webmailBody(body: string): string {
  if (body.length <= 1200) return body;
  return `${body.slice(0, 1200)}\n\n（超长已截断——全文已复制到剪贴板，粘贴即得完整内容）`;
}

/** 附件截图：data 为纯 Base64（不带 data: 前缀）。上限：≤3 张、单张 ≤2MB */
export interface FeedbackImage {
  name: string;
  mime: string;
  data: string;
}

export const FEEDBACK_IMAGE_MAX_COUNT = 3;
export const FEEDBACK_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 端点通道的 JSON 负载（与后端 feedback.rs FeedbackPayloadDto 同构） */
export interface FeedbackPayload {
  app: "mesa";
  kind: FeedbackKind;
  title: string;
  detail: string;
  contact: string | null;
  env: {
    version: string | null;
    os: string | null;
    arch: string | null;
    channel: string | null;
  };
  errorLog?: string | null;
  images?: FeedbackImage[];
  chatSnapshot?: string;
}

export function feedbackPayload(
  input: FeedbackBodyInput & {
    env?: FeedbackEnv;
    errorLog?: string | null;
    images?: FeedbackImage[];
  },
): FeedbackPayload {
  return {
    app: "mesa",
    kind: input.kind,
    title: input.title.trim(),
    detail: input.detail.trim(),
    contact: input.contact?.trim() || null,
    env: {
      version: input.env?.version ?? null,
      os: input.env?.os ?? null,
      arch: input.env?.arch ?? null,
      channel: input.env?.channel ?? null,
    },
    ...(input.errorLog ? { errorLog: input.errorLog } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.chatSnapshot ? { chatSnapshot: input.chatSnapshot } : {}),
  };
}

/** 邮件通道的附件注记：mailto 带不了附件，截图已由后端落盘，
 *  正文里注明目录让收件人知道去哪找、发件人记得在邮件里添加 */
export function feedbackImageNote(dir: string, count: number): string {
  return `本反馈附有 ${count} 张截图，已存到：${dir}（请在邮件中把它们添加为附件）`;
}

/** 邮件类通道的诊断包注记（同截图：邮件应用 / 网页邮箱带不了附件） */
export function feedbackDiagnosticsNote(path: string): string {
  return `本反馈附有诊断包，已存到：${path}（请在邮件中添加为附件）`;
}

/** 截图缩略图的 data URL（表单里预览用，不出站） */
export function feedbackImageSrc(img: FeedbackImage): string {
  return `data:${img.mime};base64,${img.data}`;
}

/**
 * 发送方式：公司端点未配置时由用户在表单里选，选择记在本机。
 * - mail：调起系统邮件应用（mailto，内容全预填）
 * - webmail：打开网页邮箱写信页（Gmail/Outlook 带正文，QQ/163 靠剪贴板）
 * - smtp：用户自己的邮箱从 Mesa 里直接发（截图与诊断包是真实附件）
 * 端点配置后不再给选择——后台直发就是最省事的那条。
 */
export type FeedbackChannel = "mail" | "webmail" | "smtp";

export const FEEDBACK_CHANNELS: {
  id: FeedbackChannel;
  label: string;
  hint: string;
}[] = [
  { id: "mail", label: "邮件应用", hint: "打开本机邮件应用，内容已填好，点发送即可" },
  { id: "webmail", label: "网页邮箱", hint: "在浏览器里打开你的邮箱写信，已登录就能直接发" },
  { id: "smtp", label: "邮箱直发", hint: "用你自己的邮箱从 Mesa 里直接发出，附件随信送达" },
];

export const FEEDBACK_CHANNEL_KEY = "ccode.feedback.channel";
export const FEEDBACK_WEBMAIL_KEY = "ccode.feedback.webmail";

/** 记住的发送方式 → 本次默认：没记过（或值不在闭集里）时，配过邮箱直发用直发，否则邮件应用 */
export function initialFeedbackChannel(
  stored: string | null,
  smtpConfigured: boolean,
): FeedbackChannel {
  if (stored === "mail" || stored === "webmail" || stored === "smtp") return stored;
  return smtpConfigured ? "smtp" : "mail";
}

/** 记住的网页邮箱 → 本次默认（不在清单里回落第一个） */
export function initialWebmailTarget(stored: string | null): string {
  return WEBMAIL_TARGETS.some((t) => t.id === stored) ? (stored as string) : WEBMAIL_TARGETS[0].id;
}

/** 附件能否随信送达：端点与邮箱直发是真实附件；邮件应用与网页邮箱只能落盘、由用户手动添加 */
export function channelCarriesAttachments(channel: FeedbackChannel | "endpoint"): boolean {
  return channel === "endpoint" || channel === "smtp";
}
