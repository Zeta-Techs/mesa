import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp,
  AtSign,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  Smartphone,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { McpServerDto, SkillDto } from "../types";
import type { SearchResultDto } from "./FileTree";
import {
  applyMention,
  filterMesaCommands,
  mentionQueryAt,
  type MesaCommand,
} from "../composer-assist";
import { firstImageItem, imageExtFromMime } from "../terminal-input";
import { saveClipboardImage } from "../clipboard-image";
import {
  filterSlashCommands,
  slashCommandsFor,
  slashQueryOf,
} from "../slash-commands";
import { imeBlocksEnter } from "../ime-guard";
import { escInterruptSafe } from "../agent-caps";
import InsertMenuItems from "./InsertMenuItems";
import { usePhoneDropStore } from "../phone-drop-store";
import type { PhoneItem } from "../phone-drop";
import ChatImageStage, { MarkupLayer } from "./ChatImageStage";
import { appendMarkRef, exportMarkup, nextMarkNumber, type Markup } from "../image-markup";
import { attachmentLines, composerImageKind } from "../chat-image";
import { docThumb, docThumbKind, docTypeLabel } from "../doc-thumb";
import { FileTypeGlyph } from "./FileTypeMark";
import ProjectFilePicker from "./ProjectFilePicker";

/** 按扩展名认图片附件（选来的、读不出缩略图的也要算） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;

/** 带附件的插入：正文进输入框，paths 按路径成附件卡（编辑后重发还原的图、拖进来的文件；图片与 PDF 补缩略图） */
export interface ComposerSeed {
  text: string;
  paths: readonly string[];
  /** 点了对话里的图「接着改」（2026-10-25）：这张图成附件后直接展开看图标注台，按改图口径（提示、占位字、发送时附原图） */
  edit?: string;
}
/** 文件卡左边没有首页预览时的类型图标（同文件列表的线条图标 + 识别色，不铺色块） */
function FileKindBlock({ path }: { path: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-full w-10 shrink-0 items-center justify-center border-r border-hairline"
    >
      <FileTypeGlyph path={path} size={16} />
    </span>
  );
}

/** 切到完全访问时细线亮多久（与 App.css ccode-tone-flash 动画时长一致） */
const TONE_FLASH_MS = 2400;

/**
 * 完全访问的提醒只在「切到」这一档时亮一下（用户：常驻显得输入框花哨）；挂载时已是完全访问不亮。
 * 输入框上沿细线与底下那行的权限字（2026-10-23：平时灰字，切到时同步亮一下 caution）各调一次，同一次提交里一起翻。
 * 单独用输入框（没有聊天层）时按档位变化认；聊天层里改用 useFlashOnSeq，只认人亲手换档（见下）
 */
export function useToneFlash(tone: "full" | "discuss" | null): boolean {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(tone);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = tone;
    if (tone !== "full" || prev === "full") {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), TONE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [tone]);
  return flash;
}

/**
 * 聊天层的完全访问提醒：只在人亲手切到完全访问（权限菜单、模型菜单、⇧Tab）时亮一下，`seq` 每次加一。
 * 切换对话、对话刚打开时档位读进来（null → full）都不亮（2026-10-25 用户：每切一段对话都亮一下很难看）
 */
export function useFlashOnSeq(seq: number): boolean {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(seq);
  useEffect(() => {
    if (prevRef.current === seq) return;
    prevRef.current = seq;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), TONE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [seq]);
  return flash;
}

/**
 * 发送钮 = Mesa 图标里 M▁ 那块光标（2026-10-22 用户：圆形按钮做成图标里的小方块）：横向圆角块，
 * 没字是灰块，有字亮成琥珀带一点余辉。样式在 App.css .ccode-send-block（data-state）
 */
function SendBlock({
  disabled,
  busy,
  queued = false,
  queuedTitle,
  onClick,
}: {
  disabled: boolean;
  busy: boolean;
  queued?: boolean;
  queuedTitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-state={disabled ? "empty" : "ready"}
      title={queued ? (queuedTitle ?? "排队：这一轮结束后处理（Enter 也是）") : busy ? "正在发送…" : "Enter 发送 · Shift+Enter 换行"}
      aria-label={queued ? "排队发送" : "发送"}
      aria-busy={busy || undefined}
      className="ccode-send-block"
    >
      <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" />
    </button>
  );
}

/**
 * 「+」添加菜单（docs/design-chat-layer.md §4.1，2026-10-17 第二期）：文件或图片 / 引用项目文件 / 技能 / MCP。
 * 原先只能插技能、MCP，加文件只能拖或粘，用户不知道能给 AI 文件。
 */
function AddMenu({
  skills,
  mcps,
  disabled,
  canMention,
  onInsert,
  onPickFiles,
  onMention,
  onPhone,
}: {
  skills: SkillDto[];
  mcps: McpServerDto[];
  disabled: boolean;
  /** 有工作目录才能引用项目文件 */
  canMention: boolean;
  onInsert: (text: string) => void;
  onPickFiles: () => void;
  onMention: () => void;
  /** 「从手机添加」：扫码传照片 / 文件 / 一句话，收到的直接附到这个输入框 */
  onPhone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const row =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-l2 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <span className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? "bg-hover text-l1" : "text-l3"
        }`}
        title="添加文件、引用项目文件、技能或 MCP"
        aria-label="添加"
      >
        <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭添加菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-72 overflow-auto rounded-lg border border-field ccode-float-surface p-1">
            <li>
              <button
                type="button"
                className={row}
                onClick={() => {
                  setOpen(false);
                  onPickFiles();
                }}
              >
                <Paperclip size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                文件或图片
                <span className="ml-auto text-micro text-l4">也可以拖进来、粘贴</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className={row}
                onClick={() => {
                  setOpen(false);
                  onPhone();
                }}
              >
                <Smartphone size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                从手机添加
                <span className="ml-auto text-micro text-l4">扫码传照片和文件</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className={row}
                disabled={!canMention}
                title={canMention ? "从这个项目里挑文件；也可以在输入框里打 @ 搜" : "先选项目或文件夹"}
                onClick={() => {
                  setOpen(false);
                  onMention();
                }}
              >
                <AtSign size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                引用项目文件
                <span className="ml-auto font-mono text-micro text-l4">@</span>
              </button>
            </li>
            <li className="mx-1 my-1 h-px bg-hairline" aria-hidden="true" />
            {/* 技能 / MCP 条目与运行页收缩行 / 标签栏 ✦ 同一组件，三处长一样 */}
            <InsertMenuItems
              skills={skills}
              mcps={mcps}
              onSkill={(name) => {
                setOpen(false);
                onInsert(`使用 ${name} 技能：`);
              }}
              onMcp={(name) => {
                setOpen(false);
                onInsert(`使用 ${name} 这个 MCP server 提供的工具：`);
              }}
            />
          </ul>
        </>
      )}
    </span>
  );
}

export default function ChatComposer({
  disabled,
  busy,
  placeholder,
  skills = [],
  mcps = [],
  onSend,
  focusWhen = true,
  agentId,
  seedInsert,
  onSeedConsumed,
  footer,
  running,
  onInterrupt,
  narrow = false,
  cwd = null,
  mesaCommands = [],
  recallHistory = [],
  tone = null,
  toneFlash: toneFlashGiven,
  onCyclePermission,
  imageWarning = null,
  onImagesChange,
  onDraftChange,
  onImageStageChange,
  queueHint = null,
  stopTitle = null,
  suggestion = null,
}: {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  skills?: SkillDto[];
  mcps?: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  /** 聊天层常驻挂载仅隐藏后，可见性翻转时重新聚焦输入框（替代挂载期一次性 autofocus） */
  focusWhen?: boolean;
  /** 当前 agent id：斜杠命令面板按 agent 出命令清单 */
  agentId?: string | null;
  /** 拖入文件等外部插入：追加到输入框并消费；对象形式（编辑后重发）里的图片还原成附件缩略卡 */
  seedInsert?: string | ComposerSeed | null;
  onSeedConsumed?: () => void;
  /**
   * 输入框下面那一行（2026-10-23 用户：照 Claude 客户端那样简洁）：权限 · 项目 | 模型 · 思考。
   * 框里只留「+ 正在写的话 发送」；这一行由调用方给，底部状态栏在时调用方改挂进状态栏、这里不传
   */
  footer?: ReactNode;
  /** 正在生成：发送钮本体变成「进行中」停止钮（符号），点击走 onInterrupt。
   *  进程活着但停在提示符时不要传 true——那时要点发送，Esc 会误伤 TUI。
   *  Grok Build 不适用（非 prompt 态 Esc 会退出整进程），调用方按 agent 过滤。 */
  running?: boolean;
  /** 聊天空态居中时收窄到约 720px（与问候、起手提示同宽）；开聊后回到正常宽度 */
  narrow?: boolean;
  /** 暂停当前生成（往终端写 Esc——不是退出会话；输入文字后仍可用 Enter 发送） */
  onInterrupt?: () => void;
  /** 工作目录：@ 引用项目文件在这里搜 */
  cwd?: string | null;
  /** 斜杠面板上半组「Mesa」操作（由 Mesa 执行，不写进终端） */
  mesaCommands?: MesaCommand[];
  /** 自己发过的话（最近的在前）：输入框为空时按 ↑ 取第一条，接着 ↑ / ↓ 在这串里走 */
  recallHistory?: readonly string[];
  /** 权限写在输入框本身上（2026-10-22）：切到完全访问时上沿亮一下 caution 细线再淡掉（不常驻）；只讨论虚线框。其余档不加任何东西 */
  tone?: "full" | "discuss" | null;
  /** 聊天层给定的「细线现在亮不亮」（只认人亲手换档，useFlashOnSeq）；不给时按 tone 变化自己认 */
  toneFlash?: boolean;
  /** ⇧Tab 轮换权限档（只在开聊前给；开聊后换档要重开，不走快捷键） */
  onCyclePermission?: () => void;
  /** 输入框里有图、而当前模型看不了图时的一句提示（模型能力库判定，调用方给） */
  imageWarning?: string | null;
  /** 附件里有没有图片（给调用方判断要不要查模型能不能看图） */
  onImagesChange?: (kind: "plain" | "marks" | null) => void;
  /** 输入框里有没有没发的字或附件 */
  onDraftChange?: (hasDraft: boolean) => void;
  /** 看图标注台开 / 关（调用方据此把居中空态换成输入框在底部，让图有地方放） */
  onImageStageChange?: (open: boolean) => void;
  /** 生成中停止块旁那组的字：这家 CLI 是「下一步交给它」还是「排队」（mid-turn-send.ts queueSendHint）；不传写「排队」 */
  queueHint?: { label: string; title: string } | null;
  /** 停止块的悬停说明（按 Esc 的几家，有排着的话时停下就马上处理那句，mid-turn-send.ts stopTitle） */
  stopTitle?: string | null;
  /** CLI 猜的下一句（Claude 输入框里那行灰字，prompt-suggestion.ts）：输入框空着时当占位字灰着显示，Tab / → 填入 */
  suggestion?: string | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const toneFlashOwn = useToneFlash(tone);
  const toneFlash = toneFlashGiven ?? toneFlashOwn;
  // WKWebView：确认候选的 Enter 在 compositionend 之后、isComposing 已是 false。
  // 组词开始锁上，compositionend 后再留一帧，让那次 Enter 只上屏不发送。
  const composingLockRef = useRef(false);
  const composingFrameRef = useRef<number | null>(null);

  function lockIme() {
    if (composingFrameRef.current != null) {
      cancelAnimationFrame(composingFrameRef.current);
      composingFrameRef.current = null;
    }
    composingLockRef.current = true;
  }

  function unlockImeAfterFrame() {
    composingLockRef.current = true;
    composingFrameRef.current = requestAnimationFrame(() => {
      composingLockRef.current = false;
      composingFrameRef.current = null;
    });
  }

  useEffect(
    () => () => {
      if (composingFrameRef.current != null) {
        cancelAnimationFrame(composingFrameRef.current);
      }
    },
    [],
  );
  // 图片附件（缩略卡）：粘贴的图片经 save_clipboard_image 落盘后按路径随消息发送，
  // url 是缩略图（粘贴的是本地 object URL，其余经 read_image_bytes 读成 data URL），点开看大图
  // url 为 null = 不是图片或读不出缩略图（HEIC、白名单外）：显示文件名卡
  // phoneId：「从手机添加」送来的（× 掉时退回手机列表的「还没处理」）
  // markup：在看图标注台上画的标注（原图坐标，path 仍指原图；发送时才生成标注图替换这一行路径）
  // thumb：文档首页预览（PDF / Word / 表格）——不是图片，不算「有图」、不进看图标注台
  // edit：从对话里点进来接着改的图（标注台给改图提示与常用说法；标过的话发送时另写一行原图路径，AI 改图要用原图）
  const [attachments, setAttachments] = useState<
    { path: string; url: string | null; phoneId?: string; markup?: Markup; thumb?: string; edit?: boolean }[]
  >([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 卸载时回收所有 object URL
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    },
    [],
  );
  // 发出去会不会要模型看图：调用方据此查当前模型能不能看图（看不了的在附件下面说一句）。
  // 接着改的图没标过时只交路径给出图工具，不算（composerImageKind）
  const imageKind = composerImageKind(
    attachments.map((a) => ({
      path: a.path,
      isImage: a.url != null || IMAGE_EXT.test(a.path),
      edit: a.edit,
      marked: (a.markup?.marks.length ?? 0) > 0,
    })),
  );
  useEffect(() => {
    onImagesChange?.(imageKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKind]);
  // 有没有没发出去的东西（字或附件）：调用方据此决定切走时能不能把这个标签顺手收掉
  const hasDraft = value.trim() !== "" || attachments.length > 0;
  useEffect(() => {
    onDraftChange?.(hasDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDraft]);
  // ↑ 一路往回取：-1 = 没在翻；翻出来的那条被改过就退出翻历史，↑ ↓ 回到在文字里移动光标
  const recallIdxRef = useRef(-1);

  function removeAttachment(path: string) {
    const hit = attachmentsRef.current.find((a) => a.path === path);
    if (hit?.phoneId) {
      void invoke<PhoneItem>("phone_drop_set_status", { id: hit.phoneId, status: "new" })
        .then((item) => usePhoneDropStore.getState().patchItem(item))
        .catch(() => undefined);
    }
    setAttachments((cur) => {
      const found = cur.find((a) => a.path === path);
      if (found?.url) URL.revokeObjectURL(found.url);
      return cur.filter((a) => a.path !== path);
    });
  }

  // ---- 从手机添加：本输入框是接收目标时，收到的东西变成附件卡 / 文字（不自动发送） ----
  const composerId = useId();
  const phoneIsTarget = usePhoneDropStore((s) => s.target?.composerId === composerId);
  const phoneReceiving = usePhoneDropStore((s) => s.status.receiving);
  const phoneDialogOpen = usePhoneDropStore((s) => s.open);
  const phoneReceived = usePhoneDropStore((s) => s.status.received);
  const phoneWho = usePhoneDropStore((s) =>
    s.status.connected ? `${s.status.lastDevice ?? "手机"} 已连上` : "手机接收中",
  );
  const phoneDeliveries = usePhoneDropStore((s) => s.deliveries);
  useEffect(() => {
    const mine = usePhoneDropStore.getState().takeDeliveries(composerId);
    for (const item of mine) {
      if (item.kind === "text") {
        if (item.text) insertResourceText(item.text);
        continue;
      }
      const path = item.path;
      if (!path || attachmentsRef.current.some((a) => a.path === path)) continue;
      setAttachments((cur) => [...cur, { path, url: null, phoneId: item.id }]);
      if (item.kind === "image") loadThumb(path);
    }
    // insertResourceText 每次渲染重建，只按送达队列翻转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneDeliveries, composerId]);
  useEffect(() => () => usePhoneDropStore.getState().releaseTarget(composerId), [composerId]);
  function openPhoneDrop() {
    // 有已配对的手机：直接开始接收，不弹窗；没有：弹窗扫码配对
    usePhoneDropStore.getState().openForComposer({ composerId, cwd: cwd ?? null });
  }

  /** 已在附件里的图片补缩略图：走白名单读图（粘贴区 / 手机暂存区 / 工作目录）；HEIC 等读不了的保持文件名卡 */
  function loadThumb(path: string) {
    void invoke<{ mime: string; data: string }>("read_image_bytes", { path, cwdHint: cwd ?? null })
      .then((img) =>
        setAttachments((cur) =>
          cur.map((a) => (a.path === path ? { ...a, url: `data:${img.mime};base64,${img.data}` } : a)),
        ),
      )
      .catch(() => undefined);
  }

  /** 文档附件补首页预览（PDF / Word / 表格，doc-thumb.ts；读不到就留类型色块） */
  function loadDocThumb(path: string) {
    void docThumb(path, cwd ?? null)
      .then((thumb) => {
        if (thumb) setAttachments((cur) => cur.map((a) => (a.path === path ? { ...a, thumb } : a)));
      })
      .catch(() => undefined);
  }

  /** 加一批按路径的附件（选文件 / 拖进来 / 编辑后重发还原的图）：去重，图片补缩略图、文档补首页预览 */
  function addPathAttachments(paths: readonly string[]) {
    const fresh = paths.filter(
      (p, i) => paths.indexOf(p) === i && !attachmentsRef.current.some((a) => a.path === p),
    );
    if (fresh.length === 0) return;
    setAttachments((cur) => [
      ...cur,
      ...fresh.filter((p) => !cur.some((a) => a.path === p)).map((p) => ({ path: p, url: null })),
    ]);
    fresh.filter((p) => IMAGE_EXT.test(p)).forEach(loadThumb);
    fresh.filter((p) => docThumbKind(p) !== null).forEach(loadDocThumb);
  }

  // 看图标注台（2026-10-23 用户：点图只能放大、看不着编辑消息）：点缩略图在输入框上方展开、盖住对话区，
  // 输入框照常能写；再点一次同一张或 Esc 收起
  const [viewing, setViewing] = useState<string | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [stageRoom, setStageRoom] = useState(0);
  // 发过的最大意见框编号（撤销掉的也算，免得和消息里已写的圈码重号）；发送后归零
  const markCounterRef = useRef(0);
  // 标注台高度 = 输入框上沿到聊天面板顶：每次渲染量一遍（输入框随字数 / 附件长高时跟着让），
  // 窗口或面板尺寸变了由 ResizeObserver 补量
  const measureStage = () => {
    const outer = outerRef.current;
    const parent = outer?.parentElement;
    if (!outer || !parent) return;
    setStageRoom(Math.max(0, outer.getBoundingClientRect().top - parent.getBoundingClientRect().top));
  };
  useLayoutEffect(() => {
    if (viewing) measureStage();
  });
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const parent = outer?.parentElement;
    if (!viewing || !outer || !parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureStage);
    ro.observe(outer);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [viewing]);
  const viewed = viewing ? attachments.find((a) => a.path === viewing && a.url) : undefined;
  const stageOpen = Boolean(viewed);
  useEffect(() => {
    onImageStageChange?.(stageOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageOpen]);

  function toggleStage(path: string) {
    setViewing((cur) => (cur === path ? null : path));
    requestAnimationFrame(() => ref.current?.focus());
  }
  /** 标注台 × / Esc：普通附件只收起；从对话点进来改的图是「取消改图」，缩略图一并移除
   *（2026-10-25 用户：关了上面、下面还留着图）。点缩略图收起不走这里，图照留 */
  function closeStage() {
    const hit = viewing ? attachmentsRef.current.find((a) => a.path === viewing) : undefined;
    if (hit?.edit) removeAttachment(hit.path);
    setViewing(null);
    requestAnimationFrame(() => ref.current?.focus());
  }
  function setMarkup(path: string, markup: Markup) {
    setAttachments((cur) => cur.map((a) => (a.path === path ? { ...a, markup } : a)));
  }
  /** 画好意见框：消息末尾另起一行写上圈码，光标停在后面接着写意见 */
  function addMarkRef(n: number) {
    markCounterRef.current = Math.max(markCounterRef.current, n);
    setError(null);
    setValue((cur) => appendMarkRef(cur, n));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  /** 剪贴板图片落盘（与终端粘贴同一通道 save_clipboard_image）→ 附件卡 */
  async function addImageAttachment(file: File) {
    try {
      const buf = await file.arrayBuffer();
      const path = await saveClipboardImage(buf, imageExtFromMime(file.type));
      setAttachments((cur) => [
        ...cur,
        { path, url: URL.createObjectURL(file) },
      ]);
      setError(null);
    } catch (reason) {
      setError(`粘贴图片失败：${String(reason)}`);
    }
  }

  function insertResourceText(text: string) {
    setError(null);
    setValue((current) => (current ? `${current}\n${text}` : text));
    requestAnimationFrame(() => ref.current?.focus());
  }

  // CLI 猜的下一句：输入框空着才灰着显示（同终端里的样子），填进来之后照常改、照常发
  const ghost = suggestion && !value && attachments.length === 0 && !disabled && !busy ? suggestion : null;
  function acceptSuggestion() {
    if (!ghost) return;
    insertResourceText(ghost);
    requestAnimationFrame(() => ref.current?.setSelectionRange(ghost.length, ghost.length));
  }

  /** 「+ → 文件或图片」：系统选文件，按路径随消息发出（与拖入同口径）。选择器在 Rust 侧弹，
   *  选中的文件才登记进读取白名单，项目外的图片 / PDF 也能出缩略图（attach_grants.rs） */
  async function pickFiles() {
    try {
      const paths = await invoke<string[]>("pick_attachment_files", { defaultDir: cwd ?? null });
      if (paths.length === 0) return;
      addPathAttachments(paths);
      requestAnimationFrame(() => ref.current?.focus());
    } catch (reason) {
      setError(`选文件失败：${String(reason)}`);
    }
  }

  // ---- @ 引用项目文件 ----
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mention = cwd && !mentionDismissed ? mentionQueryAt(value, caret) : null;
  const [mentionHits, setMentionHits] = useState<SearchResultDto[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionHits([]);
      return;
    }
    if (!mentionQuery) {
      setMentionHits([]);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", { root: cwd, query: mentionQuery, showHidden: false })
        .then((hits) => {
          if (!stale) {
            setMentionHits(hits.slice(0, 8));
            setMentionIdx(0);
          }
        })
        .catch(() => {
          if (!stale) setMentionHits([]);
        });
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [mentionQuery, cwd]);
  function pickMention(hit: SearchResultDto) {
    if (!mention) return;
    const next = applyMention(value, caret, mention, hit.rel.replace(/\\/g, "/"));
    setValue(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }
  /** 「+ → 引用项目文件」：弹层里挑（最近改过的在前、能搜、可多选），选中的成附件卡（2026-10-26，
   *  原先只在光标处补个 @，用户：点了选不了文件）；打 @ 就地搜照旧 */
  const [projectPickOpen, setProjectPickOpen] = useState(false);
  function addProjectFiles(paths: string[]) {
    addPathAttachments(paths);
    requestAnimationFrame(() => ref.current?.focus());
  }

  useEffect(() => {
    if (!seedInsert) return;
    if (typeof seedInsert === "string") insertResourceText(seedInsert);
    else {
      if (seedInsert.text) insertResourceText(seedInsert.text);
      else requestAnimationFrame(() => ref.current?.focus());
      addPathAttachments(seedInsert.paths);
      const edit = seedInsert.edit;
      if (edit) {
        // 已在附件里（又点了一次同一张）也照样标成改图、展开
        setAttachments((cur) =>
          cur.some((a) => a.path === edit)
            ? cur.map((a) => (a.path === edit ? { ...a, edit: true } : a))
            : [...cur, { path: edit, url: null, edit: true }],
        );
        if (!attachmentsRef.current.some((a) => a.path === edit && a.url)) loadThumb(edit);
        setViewing(edit);
      }
    }
    onSeedConsumed?.();
    // 只在 seedInsert 翻转时插入一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedInsert]);

  useEffect(() => {
    if (!disabled && focusWhen) ref.current?.focus();
  }, [disabled, focusWhen]);

  // ---- 长文本（2026-10-26 对照 Codex 网页端）：一折行就把字放到整宽的上层、+ 和发送挪到下面一排；
  // 超出高度时滚动条同侧栏树（滚时出现、停下消失）、按还能往哪边滚给上下沿渐隐，右上角给「展开」写长文 ----
  const [stacked, setStacked] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: false, overflow: false });
  // 因为折行才换成两层时的字数：删到比它短（且没有换行）就回到一行；因换行进来的记 null，删掉换行就试着回一行
  const wrapLenRef = useRef<number | null>(null);
  const scrollIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current);
  }, []);
  function syncFade(el: HTMLTextAreaElement) {
    const overflow = el.scrollHeight - el.clientHeight > 1;
    const top = overflow && el.scrollTop > 1;
    const bottom = overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFade((cur) =>
      cur.top === top && cur.bottom === bottom && cur.overflow === overflow ? cur : { top, bottom, overflow },
    );
  }
  // 随内容自动增高（封顶在 CSS max-height，超出内部滚动）；换层在绘制前定下，不闪
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === "") {
      el.style.height = "";
      wrapLenRef.current = null;
      setStacked(false);
      setExpanded(false);
      syncFade(el);
      return;
    }
    // 量高度时先压到 0 会把滚动位置挤到底，量完放回去：在长文中间改字不跳
    const keepTop = el.scrollTop;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
    el.scrollTop = keepTop;
    const hasBreak = value.includes("\n");
    if (!stacked) {
      const css = getComputedStyle(el);
      const oneLine =
        parseFloat(css.lineHeight) * 1.5 + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
      if (hasBreak || el.scrollHeight > oneLine) {
        wrapLenRef.current = hasBreak ? null : value.length;
        setStacked(true);
      }
    } else if (!hasBreak && (wrapLenRef.current === null || value.length < wrapLenRef.current)) {
      setStacked(false);
    }
    syncFade(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, stacked, expanded]);
  function toggleExpanded() {
    setExpanded((cur) => !cur);
    requestAnimationFrame(() => ref.current?.focus());
  }

  const canSubmit = !disabled && !busy && (value.trim() !== "" || attachments.length > 0);

  const submittingRef = useRef(false);
  async function submit(override?: string) {
    const text = (override ?? value).trim();
    if ((!text && attachments.length === 0) || disabled || busy || submittingRef.current) return;
    setError(null);
    submittingRef.current = true;
    try {
      // 标了的图这时才生成新图（原图不动），落盘到粘贴区，发出去的是新图路径；
      // 接着改的图写成「原图：」「标注图：」行（attachmentLines），不让 Claude Code 当图片附件发给模型
      let paths: string[];
      try {
        const lines = await Promise.all(
          attachments.map(async (a) => {
            let marked: string | null = null;
            if (a.url && a.markup && a.markup.marks.length > 0) {
              const out = await exportMarkup(a.url, a.path, a.markup);
              marked = await saveClipboardImage(out.bytes, out.ext);
            }
            return attachmentLines({ path: a.path, edit: a.edit, marked });
          }),
        );
        paths = lines.flat();
      } catch (reason) {
        setError(`生成标注图失败：${String(reason)}`);
        return;
      }
      // 图片附件按绝对路径追加在正文后（一行一个）：路径文本是九家 CLI 通吃的图片输入方式，
      // 会话文件记下这行路径，回放/聊天层据此渲染内嵌图片卡
      const payload = [text, ...paths].filter(Boolean).join("\n");
      // 先清空再发：写进终端要等 CLI 能收键、多行正文粘进去后还要等 0.65 秒才按提交，原先等发完才清空，
      // 字在框里停一下才走（2026-10-25 用户：不够丝滑）。发失败再放回去——人这时已经接着打了字就不覆盖
      const sent = { value, attachments: attachmentsRef.current };
      setValue("");
      setSlashDismissed(false);
      setViewing(null);
      setAttachments([]);
      const err = await onSend(payload);
      if (err) {
        setError(err);
        setValue((cur) => (cur === "" ? sent.value : cur));
        setAttachments((cur) => (cur.length === 0 ? sent.attachments : cur));
        return;
      }
      markCounterRef.current = 0;
      sent.attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    } finally {
      submittingRef.current = false;
    }
  }

  // 斜杠命令面板：/ 开头且无空格无换行时弹出；Enter 选中并发送，Tab 仅补全，↑/↓ 移动，Esc 收起
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery = slashDismissed ? null : slashQueryOf(value);
  // 上半组 Mesa 操作（Mesa 自己执行），下半组 CLI 命令（写进终端）；同一套 ↑↓ 选择
  const mesaList = slashQuery === null ? [] : filterMesaCommands(mesaCommands, slashQuery);
  const cliList =
    slashQuery === null
      ? []
      : filterSlashCommands(slashCommandsFor(agentId), slashQuery);
  const slashList: { cmd: string; hint: string; mesa?: MesaCommand }[] = [
    ...mesaList.map((m) => ({ cmd: m.cmd, hint: m.label, mesa: m })),
    ...cliList,
  ];
  const slashActive = Math.min(slashIdx, Math.max(0, slashList.length - 1));

  function pickSlash(cmd: string, send: boolean) {
    setSlashDismissed(true);
    const mesa = slashList.find((c) => c.cmd === cmd)?.mesa;
    if (mesa) {
      // Mesa 操作不进输入框也不写终端：清掉「/xx」再执行
      setValue("");
      mesa.run();
      return;
    }
    if (send) {
      void submit(cmd);
    } else {
      setValue(`${cmd} `);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  return (
    <div ref={outerRef} className="ccode-chat-composer relative shrink-0 bg-canvas px-4 pb-2 pt-2.5">
      {viewed?.url && (
        <ChatImageStage
          key={viewed.path}
          name={viewed.path.split(/[\\/]/).pop() ?? "图片"}
          url={viewed.url}
          markup={viewed.markup ?? null}
          nextNumber={nextMarkNumber(attachments.map((a) => a.markup), markCounterRef.current)}
          height={stageRoom}
          onChange={(m) => setMarkup(viewed.path, m)}
          onBoxAdded={addMarkRef}
          onClose={closeStage}
          onQuickText={viewed.edit ? insertResourceText : undefined}
        />
      )}
      {/* 开聊后与对话流同一条中轴：栏宽跟聊天字号走（App.css .ccode-chat-column） */}
      <div className={`mx-auto w-full ${narrow ? "max-w-[45rem]" : "ccode-chat-column"}`}>
        <div
          data-tone={tone ?? undefined}
          data-tone-flash={toneFlash || undefined}
          className="ccode-composer-box relative overflow-visible rounded-xl border border-composer-edge bg-composer transition-colors focus-within:border-l4"
        >
          {/* 斜杠命令面板：/ 开头弹出（命令表是各家 CLI 的保守常用集，见 src/slash-commands.ts） */}
          {slashList.length > 0 && (
            <div className="border-b border-hairline px-1.5 py-1.5">
              {slashList.map((c, i) => (
                <div key={`${c.mesa ? "m" : "c"}${c.cmd}`}>
                  {i === 0 && mesaList.length > 0 && (
                    <div className="px-2 pb-0.5 pt-0.5 text-micro text-l4">Mesa</div>
                  )}
                  {i === mesaList.length && cliList.length > 0 && (
                    <div
                      className={`px-2 pb-0.5 pt-1 text-micro text-l4 ${
                        mesaList.length > 0 ? "mt-1 border-t border-hairline" : ""
                      }`}
                    >
                      {agentId ? "命令（写进终端）" : "命令"}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => pickSlash(c.cmd, Boolean(c.mesa))}
                    className={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs ${
                      i === slashActive ? "bg-hover text-l1" : "text-l2"
                    }`}
                  >
                    {c.mesa ? (
                      <>
                        <span className="shrink-0">{c.mesa.label}</span>
                        <span className="min-w-0 truncate text-l4">{c.mesa.hint}</span>
                        <span className="ml-auto shrink-0 font-mono text-micro text-l4">{c.cmd}</span>
                      </>
                    ) : (
                      <>
                        <span className="shrink-0 font-mono">{c.cmd}</span>
                        <span className="min-w-0 truncate text-l4">{c.hint}</span>
                      </>
                    )}
                  </button>
                </div>
              ))}
              <p className="px-2 pt-1 text-micro text-l4">
                Enter 发送选中命令 · Tab 只补全不发送 · Esc 收起
              </p>
            </div>
          )}
          {/* @ 引用项目文件：光标前是「@查询」时弹出，在工作目录里搜（search_files） */}
          {mention && (
            <div className="border-b border-hairline px-1.5 py-1.5">
              {mention.query === "" ? (
                <p className="px-2 py-1 text-micro text-l4">输入文件名的一部分，在这个文件夹里找</p>
              ) : mentionHits.length === 0 ? (
                <p className="px-2 py-1 text-micro text-l4">没找到「{mention.query}」</p>
              ) : (
                mentionHits.map((h, i) => (
                  <button
                    key={h.path}
                    type="button"
                    onMouseEnter={() => setMentionIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(h)}
                    className={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs ${
                      i === mentionIdx ? "bg-hover text-l1" : "text-l2"
                    }`}
                  >
                    <span className="shrink-0">{h.name}{h.isDir ? "/" : ""}</span>
                    <span className="min-w-0 truncate font-mono text-micro text-l4">{h.rel}</span>
                  </button>
                ))
              )}
              <p className="px-2 pt-1 text-micro text-l4">Enter 选中 · Esc 收起 · 引用的是相对路径，AI 会自己去读</p>
            </div>
          )}
          {/* 从手机添加：弹层收起后接收照常，这一行可展开或停止（30 分钟没新东西自动停） */}
          {phoneIsTarget && phoneReceiving && !phoneDialogOpen && (
            <div className="flex items-center gap-2 px-3 pt-2.5 text-micro text-l3">
              <Smartphone size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">
                {phoneWho}{phoneReceived > 0 ? ` · 已收 ${phoneReceived}` : ""}
              </span>
              <button
                type="button"
                className="ml-auto hover:text-l1"
                onClick={() => usePhoneDropStore.getState().openDialog({ composerId, cwd: cwd ?? null }, { start: false })}
              >
                展开
              </button>
              <button
                type="button"
                className="hover:text-l1"
                onClick={() => void usePhoneDropStore.getState().stop()}
              >
                停止
              </button>
            </div>
          )}
          {/* 附件缩略卡（粘贴落盘 / 选来 / 拖进来 / 手机送来；× 移除，点图在上方看图标注；发送时按路径随消息发出） */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="relative inline-flex"
                  title={a.path}
                >
                  {a.url ? (
                    <button
                      type="button"
                      className={`relative block cursor-zoom-in rounded-md border-0 bg-transparent p-0 ${
                        viewing === a.path ? "ring-2 ring-mesa-amber/70" : ""
                      }`}
                      onClick={() => toggleStage(a.path)}
                      aria-label="看图与标注"
                      aria-pressed={viewing === a.path}
                      title={viewing === a.path ? "收起图片" : "在上方看大图、标注，消息照常写"}
                    >
                      <img
                        src={a.url}
                        alt={a.path.split(/[\\/]/).pop() ?? "图片"}
                        className="h-14 w-auto rounded-md border border-hairline object-cover"
                      />
                      {a.markup && a.markup.marks.length > 0 && (
                        <svg
                          aria-label="已标注"
                          className="pointer-events-none absolute inset-0 h-full w-full rounded-md"
                          viewBox={`0 0 ${a.markup.width} ${a.markup.height}`}
                          preserveAspectRatio="none"
                        >
                          <MarkupLayer markup={a.markup} />
                        </svg>
                      )}
                    </button>
                  ) : (
                    // 文件卡：左边首页预览（PDF / Word / 表格），读不出预览的画类型色块；右边文件名 + 类型，和图片卡同高
                    <span className="flex h-14 w-52 items-center gap-2 overflow-hidden rounded-md border border-hairline bg-canvas pr-2.5">
                      {a.thumb ? (
                        <img
                          src={a.thumb}
                          alt=""
                          className="h-full w-10 shrink-0 border-r border-hairline bg-white object-cover object-top"
                        />
                      ) : (
                        <FileKindBlock path={a.path} />
                      )}
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="line-clamp-2 break-all text-xs leading-snug text-l2">
                          {a.path.split(/[\\/]/).pop()}
                        </span>
                        <span className="text-micro text-l4">{docTypeLabel(a.path)}</span>
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.path)}
                    aria-label={a.url ? "移除图片" : "移除文件"}
                    className="absolute -right-1.5 -top-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full border border-field bg-raised text-micro leading-none text-l3 hover:text-l1"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageWarning && imageKind && (
            <p className="flex items-start gap-1.5 px-4 pt-2 text-micro text-caution-text">
              <span className="ccode-icon-line">
                <TriangleAlert size={12} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="min-w-0">{imageWarning}</span>
            </p>
          )}
          {/* 只在出错时占一行。发送中不再写「正在发送…」（2026-10-24 用户：顶在框上面把框撑高，破坏原本的样子）：
              发送中输入框与发送钮本就是灰的，说明放在发送钮悬停里 */}
          {error && (
            <p className="truncate px-4 pt-2 text-micro text-l4" title={error}>
              {error}
            </p>
          )}
          {/* 框里只有一行：+ · 正在写的话 · 发送（2026-10-23 用户：照 Claude 客户端那样简洁）；
              权限、项目、模型挪到框下面那一行。居中空态也是一行（同日用户：两行高、上下两排都嫌大），只是栏宽收窄。
              字一折行就换成上下两层（2026-10-26 对照 Codex 网页端）：字占满整宽，+ 和发送挪到下面一排；
              同一组节点只换 grid 区域（App.css .ccode-composer-row），焦点和光标不丢 */}
          <div
            data-stacked={stacked || undefined}
            className={`ccode-composer-row px-2 ${stacked ? "pb-1.5 pt-2" : "py-1.5"}`}
          >
          <span data-slot="add" className="flex h-[34px] shrink-0 items-center">
            <AddMenu
              skills={skills}
              mcps={mcps}
              disabled={Boolean(disabled || busy)}
              canMention={Boolean(cwd)}
              onInsert={insertResourceText}
              onPickFiles={() => void pickFiles()}
              onMention={() => setProjectPickOpen(true)}
              onPhone={openPhoneDrop}
            />
          </span>
          <div data-slot="text" className="relative min-w-0">
          <textarea
            ref={ref}
            value={value}
            disabled={disabled || busy}
            data-fade-top={fade.top || undefined}
            data-fade-bottom={fade.bottom || undefined}
            onPaste={(e) => {
              // 剪贴板有图片条目则接管粘贴（落盘为附件卡），纯文本走默认粘贴
              const items = Array.from(e.clipboardData?.items ?? []);
              const idx = firstImageItem(items);
              if (idx < 0) return;
              e.preventDefault();
              const file = items[idx].getAsFile();
              if (file) void addImageAttachment(file);
            }}
            onChange={(e) => {
              setValue(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              if (error) setError(null);
              if (slashDismissed) setSlashDismissed(false);
              if (mentionDismissed) setMentionDismissed(false);
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              syncFade(el);
              // 滚动条同侧栏树：滚动时打标显出来，停 0.9 秒摘掉（App.css .ccode-composer-text）
              el.dataset.scrolling = "1";
              if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current);
              scrollIdleRef.current = setTimeout(() => {
                delete el.dataset.scrolling;
              }, 900);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onCompositionStart={lockIme}
            onCompositionEnd={unlockImeAfterFrame}
            onKeyDown={(e) => {
              // 组词中 / 确认候选的 Enter：只上屏，不发送（WKWebView 上 isComposing 不可靠）
              if (
                imeBlocksEnter({
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.keyCode,
                  composingLock: composingLockRef.current,
                })
              ) {
                return;
              }
              // @ 引用面板开着时：↑/↓ 移动、Enter / Tab 选中、Esc 收起
              if (mention && mentionHits.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setMentionIdx((mentionIdx + delta + mentionHits.length) % mentionHits.length);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(mentionHits[Math.min(mentionIdx, mentionHits.length - 1)]);
                  return;
                }
              }
              if (mention && e.key === "Escape") {
                e.preventDefault();
                setMentionDismissed(true);
                return;
              }
              // ⇧Tab 轮换权限档（开聊前；面板开着时不抢）：和 Claude Code 终端里同一个手势
              if (e.key === "Tab" && e.shiftKey && onCyclePermission && slashList.length === 0 && !mention) {
                e.preventDefault();
                onCyclePermission();
                return;
              }
              // 灰着的建议：Tab / → 填进来（终端里是 Tab；空着回车直接发那条不照搬，免得手滑替你发出一句猜的话）
              if (ghost && !e.shiftKey && (e.key === "Tab" || e.key === "ArrowRight")) {
                e.preventDefault();
                acceptSuggestion();
                return;
              }
              // ↑ 一路往回取自己发过的话（终端历史同习惯）：输入框为空时开始；翻出来的那条没改过才接着翻，
              // 多行的那条光标在第一行才往更早翻、在最后一行 ↓ 才往回翻，其余时候 ↑ ↓ 照常在文字里移动
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && slashList.length === 0 && recallHistory.length > 0) {
                const el = e.currentTarget;
                const idx = recallIdxRef.current;
                const browsing = idx >= 0 && value === recallHistory[idx];
                if (!browsing) recallIdxRef.current = -1;
                const pos = el.selectionStart ?? 0;
                const onFirstLine = !value.slice(0, pos).includes("\n");
                const onLastLine = !value.slice(pos).includes("\n");
                let next: number | null = null;
                if (e.key === "ArrowUp" && (!value || (browsing && onFirstLine))) {
                  next = Math.min(recallHistory.length - 1, (browsing ? idx : -1) + 1);
                  if (browsing && next === idx) next = null;
                } else if (e.key === "ArrowDown" && browsing && onLastLine) {
                  next = idx - 1;
                }
                if (next !== null) {
                  e.preventDefault();
                  recallIdxRef.current = next;
                  const text = next >= 0 ? recallHistory[next] : "";
                  setValue(text);
                  requestAnimationFrame(() => {
                    ref.current?.setSelectionRange(text.length, text.length);
                  });
                  return;
                }
              }
              // 斜杠面板开着时：↑/↓ 移动、Enter 选中并发送、Tab 仅补全、Esc 收起
              if (slashList.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIdx(
                    (slashActive + delta + slashList.length) % slashList.length,
                  );
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickSlash(slashList[slashActive].cmd, true);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  pickSlash(slashList[slashActive].cmd, false);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              // 展开写长文时：Esc 先收回原来的高度（字不动）
              if (e.key === "Escape" && expanded) {
                e.preventDefault();
                setExpanded(false);
                return;
              }
              // 看图标注台开着：Esc 先收起它（面板类都收完了才轮到这里）
              if (e.key === "Escape" && viewing) {
                e.preventDefault();
                closeStage();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            // 一行起，随内容长高（2026-10-23 用户：空态两行高太大，一行就行）
            rows={1}
            placeholder={ghost ?? (viewed?.edit ? "描述修改内容" : placeholder) ?? "输入消息"}
            // 插入符是 M▁ 那道琥珀（--color-mesa-amber），光标本身就是品牌。
            // 平时封顶九行，「展开」后至少占四成窗口高（App.css .ccode-composer-text：滚动条滚时才出、上下沿渐隐）
            className={`ccode-composer-text block w-full resize-none bg-transparent px-1.5 py-[5px] text-sm leading-6 text-l1 caret-mesa-amber outline-none focus:outline-none focus-visible:outline-none focus-visible:outline-offset-0 placeholder:text-l3 disabled:cursor-not-allowed disabled:opacity-60 ${
              expanded ? "max-h-[min(60vh,40rem)] min-h-[min(40vh,24rem)]" : "max-h-[13.5rem]"
            } ${ghost ? "pr-20" : stacked && (fade.overflow || expanded) ? "pr-8" : ""}`}
          />
          {stacked && (fade.overflow || expanded) && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleExpanded}
              title={expanded ? "收回（Esc）" : "展开输入框，写长文更方便"}
              aria-label={expanded ? "收回输入框" : "展开输入框"}
              aria-pressed={expanded}
              className="absolute right-0 top-0.5 inline-flex size-7 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              {expanded ? (
                <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
          )}
          {ghost && (
            // 灰字是 CLI 猜的下一句：右上角说一声怎么填，点一下也行
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={acceptSuggestion}
              title={`灰字是它猜你下一句想说的话，按 Tab 填进输入框，改完再发`}
              className="absolute right-0 top-[5px] flex h-6 items-center gap-1 rounded-md px-1.5 text-l4 transition-colors hover:bg-hover hover:text-l2"
            >
              {/* 字号写在里层（全站 button { font: inherit } 会吞掉按钮自己的 text-*） */}
              <kbd className="rounded border border-hairline px-1 font-sans text-micro leading-4">Tab</kbd>
              <span className="text-micro">填入</span>
            </button>
          )}
          </div>
            <div data-slot="send" className="flex h-[34px] shrink-0 items-center gap-1.5">
              {running &&
              onInterrupt &&
              !busy &&
              (agentId == null || escInterruptSafe(agentId)) ? (
                /* 正在生成：发送钮让位给停止钮（琥珀描边 + 实心方块，不闪），点击 = 往终端发 Esc 暂停。
                   这时又打了字：停止钮旁写「排队」并亮出发送钮——Enter / 点它都是排队，这一轮结束后处理。
                   Grok 无停止钮：非 prompt 态 Esc 会退出整进程。 */
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onInterrupt();
                      // 停止后焦点回输入框：「这一轮停下、可以接着打下一句」
                      ref.current?.focus();
                    }}
                    title={stopTitle ?? "暂停当前生成（往终端发送 Esc；会话保留，可继续输入）"}
                    aria-label="暂停当前生成"
                    data-state="stop"
                    className="ccode-send-block"
                  >
                    <Square size={8} strokeWidth={0} fill="currentColor" aria-hidden="true" />
                  </button>
                  {canSubmit && (
                    <>
                      {/* 写法按这家 CLI 的真实行为：Claude / Codex 等是「下一步交给它」，不是排到这一轮之后 */}
                      <span className="shrink-0 text-micro text-l4">{queueHint?.label ?? "排队"}</span>
                      <SendBlock
                        disabled={false}
                        busy={false}
                        onClick={() => void submit()}
                        queued
                        queuedTitle={queueHint?.title}
                      />
                    </>
                  )}
                </>
              ) : (
                <SendBlock disabled={!canSubmit} busy={Boolean(busy)} onClick={() => void submit()} />
              )}
            </div>
          </div>
        </div>
        {footer}
      </div>
      {cwd && (
        <ProjectFilePicker
          open={projectPickOpen}
          cwd={cwd}
          onClose={() => setProjectPickOpen(false)}
          onAdd={addProjectFiles}
        />
      )}
    </div>
  );
}
