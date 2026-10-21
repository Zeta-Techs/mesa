import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AtSign, FileText, Paperclip, Plus, Smartphone, Square } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
                title={canMention ? undefined : "先选项目或文件夹"}
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
  cwdHint,
  cwdTitle,
  onChooseCwd,
  leftExtras,
  rightExtras,
  running,
  onInterrupt,
  narrow = false,
  cwd = null,
  mesaCommands = [],
  recallText = null,
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
  /** 拖入文件等外部插入：追加到输入框并消费 */
  seedInsert?: string | null;
  onSeedConsumed?: () => void;
  /** 空态目录短句，画在 + 右侧，不另占一行 */
  cwdHint?: string | null;
  cwdTitle?: string;
  onChooseCwd?: () => void;
  /** 左下角扩展位（原聊天头部功能迁入：状态注记 / 只读分叉） */
  leftExtras?: ReactNode;
  /** 发送钮左边（开聊前 Agent·模型选择 / 开聊后「模型 · 思考」芯片） */
  rightExtras?: ReactNode;
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
  /** 输入框为空时按 ↑ 取回的上一句 */
  recallText?: string | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
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
  // url 是本地 object URL 只用于输入框里的预览缩略图
  // url 为 null = 「+ → 文件或图片」选来的文件：不做缩略图，显示文件名卡
  // phoneId：「从手机添加」送来的（× 掉时退回手机列表的「还没处理」）
  const [attachments, setAttachments] = useState<
    { path: string; url: string | null; phoneId?: string }[]
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
      if (item.kind === "image") {
        // 缩略图走白名单读图（暂存区已在白名单）；HEIC 等读不了的就保持文件名卡
        void invoke<{ mime: string; data: string }>("read_image_bytes", { path })
          .then((img) =>
            setAttachments((cur) =>
              cur.map((a) => (a.path === path ? { ...a, url: `data:${img.mime};base64,${img.data}` } : a)),
            ),
          )
          .catch(() => undefined);
      }
    }
    // insertResourceText 每次渲染重建，只按送达队列翻转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneDeliveries, composerId]);
  useEffect(() => () => usePhoneDropStore.getState().releaseTarget(composerId), [composerId]);
  function openPhoneDrop() {
    // 有已配对的手机：直接开始接收，不弹窗；没有：弹窗扫码配对
    usePhoneDropStore.getState().openForComposer({ composerId, cwd: cwd ?? null });
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
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.style.height = "0";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    });
  }

  /** 「+ → 文件或图片」：系统选文件，按路径随消息发出（与拖入同口径） */
  async function pickFiles() {
    try {
      const picked = await openDialog({ multiple: true, directory: false, defaultPath: cwd ?? undefined });
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      setAttachments((cur) => [
        ...cur,
        ...paths.filter((p) => !cur.some((a) => a.path === p)).map((p) => ({ path: p, url: null })),
      ]);
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
  /** 「+ → 引用项目文件」：在光标处补一个 @ 打开搜索 */
  function startMention() {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const needSpace = at > 0 && !/\s/.test(value[at - 1]);
    const insert = needSpace ? " @" : "@";
    const next = value.slice(0, at) + insert + value.slice(at);
    setValue(next);
    setMentionDismissed(false);
    setCaret(at + insert.length);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + insert.length, at + insert.length);
    });
  }

  useEffect(() => {
    if (!seedInsert) return;
    insertResourceText(seedInsert);
    onSeedConsumed?.();
    // 只在 seedInsert 翻转时插入一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedInsert]);

  useEffect(() => {
    if (!disabled && focusWhen) ref.current?.focus();
  }, [disabled, focusWhen]);

  // 发送清空后把自动增高复位（onChange 不会因 setValue("") 触发）
  useEffect(() => {
    const el = ref.current;
    if (el && value === "") el.style.height = "";
  }, [value]);

  async function submit(override?: string) {
    const text = (override ?? value).trim();
    if ((!text && attachments.length === 0) || disabled || busy) return;
    setError(null);
    // 图片附件按绝对路径追加在正文后（一行一个）：路径文本是九家 CLI 通吃的图片输入方式，
    // 会话文件记下这行路径，回放/聊天层据此渲染内嵌图片卡
    const payload = [text, ...attachments.map((a) => a.path)]
      .filter(Boolean)
      .join("\n");
    const err = await onSend(payload);
    if (err) {
      setError(err);
      return;
    }
    setValue("");
    setSlashDismissed(false);
    setAttachments((cur) => {
      cur.forEach((a) => a.url && URL.revokeObjectURL(a.url));
      return [];
    });
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
    <div className="ccode-chat-composer shrink-0 bg-canvas px-4 pb-2 pt-2.5">
      {/* 开聊后与对话流同一条中轴：栏宽跟聊天字号走（App.css .ccode-chat-column） */}
      <div className={`mx-auto w-full ${narrow ? "max-w-[45rem]" : "ccode-chat-column"}`}>
        <div className="overflow-visible rounded-xl border border-hairline bg-raised transition-colors focus-within:border-l4">
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
          {/* 图片附件缩略卡（粘贴落盘后展示，× 移除；发送时按路径随消息发出） */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="relative inline-flex"
                  title={a.path}
                >
                  {a.url ? (
                    <img
                      src={a.url}
                      alt={a.path.split(/[\\/]/).pop() ?? "图片"}
                      className="h-14 w-auto rounded-md border border-hairline object-cover"
                    />
                  ) : (
                    <span className="flex h-9 max-w-[14rem] items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2 text-xs text-l2">
                      <FileText size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                      <span className="truncate">{a.path.split(/[\\/]/).pop()}</span>
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
          <textarea
            ref={ref}
            value={value}
            disabled={disabled || busy}
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
              // 随内容自动增高（max-h-40 封顶，超出内部滚动）
              const el = e.target;
              el.style.height = "0";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
              // 输入框为空时按 ↑：取回自己上一句来改（终端里的历史同习惯）
              if (e.key === "ArrowUp" && !value && recallText && slashList.length === 0) {
                e.preventDefault();
                setValue(recallText);
                requestAnimationFrame(() => {
                  const el = ref.current;
                  if (!el) return;
                  el.style.height = "0";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  el.setSelectionRange(recallText.length, recallText.length);
                });
                return;
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
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={placeholder ?? "输入消息…"}
            className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm leading-6 text-l1 outline-none focus:outline-none focus-visible:outline-none focus-visible:outline-offset-0 placeholder:text-l4 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex min-h-10 items-center justify-between gap-2 px-3 pb-1.5">
            <div className="flex min-w-0 items-center gap-0.5">
              <AddMenu
                skills={skills}
                mcps={mcps}
                disabled={Boolean(disabled || busy)}
                canMention={Boolean(cwd)}
                onInsert={insertResourceText}
                onPickFiles={() => void pickFiles()}
                onMention={startMention}
                onPhone={openPhoneDrop}
              />
              {cwdHint && !error && !busy ? (
                onChooseCwd ? (
                  <button
                    type="button"
                    onClick={onChooseCwd}
                    title={cwdTitle}
                    className="ml-1 max-w-[14rem] truncate font-mono text-micro text-l4 hover:text-l2"
                  >
                    {cwdHint}
                  </button>
                ) : (
                  <span
                    className="ml-1 max-w-[14rem] truncate font-mono text-micro text-l4"
                    title={cwdTitle}
                  >
                    {cwdHint}
                  </span>
                )
              ) : null}
              {(error || busy) && (
                <span className="ml-2 truncate text-micro text-l4">
                  {error ?? "正在发送…"}
                </span>
              )}
              {leftExtras}
            </div>
            <div className="flex min-w-0 shrink items-center gap-1.5">
              {rightExtras}
              {running &&
              onInterrupt &&
              !busy &&
              (agentId == null || escInterruptSafe(agentId)) ? (
                /* 正在生成：发送钮本体变「进行中」停止钮，点击 = 往终端发 Esc 暂停；
                   打字中的消息仍可用 Enter 发送（submit 走键盘路径，不经此钮）。
                   Grok 无此钮：非 prompt 态 Esc 会退出整进程。 */
                <button
                  type="button"
                  onClick={() => {
                    onInterrupt();
                    // 停止后焦点回输入框：「这一轮停下、可以接着打下一句」
                    ref.current?.focus();
                  }}
                  title="暂停当前生成（往终端发送 Esc；会话保留，可继续输入）"
                  aria-label="暂停当前生成"
                  className="inline-flex h-8 w-8 shrink-0 animate-pulse items-center justify-center rounded-md bg-cta text-cta-text transition-opacity hover:opacity-90"
                >
                  <Square
                    size={11}
                    strokeWidth={0}
                    fill="currentColor"
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    disabled ||
                    busy ||
                    (!value.trim() && attachments.length === 0)
                  }
                  onClick={() => void submit()}
                  title="Enter 发送 · Shift+Enter 换行"
                  className="inline-flex h-8 shrink-0 items-center rounded-md bg-cta px-3 text-xs text-cta-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? "发送中…" : "发送"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
