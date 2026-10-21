import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, File, FileText, Image as ImageIcon, MessageSquareText, Smartphone, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import OfficePreviewModal from "./OfficePreviewModal";
import {
  FoldMark,
  InlineNotice,
  MenuSelect,
  Toggle,
  ghostActionClass,
  primaryActionClass,
  projectWellClass,
  secondaryActionClass,
} from "./PageFrame";
import { usePhoneDropStore } from "../phone-drop-store";
import {
  PHONE_PLACE_TARGET,
  formatPhoneSize,
  phoneDeviceLine,
  phoneItemActions,
  phoneItemOpenable,
  phoneItemStatusText,
  phonePairedCard,
  phoneStateLine,
  pickPlaceProject,
  placeableProjects,
  type PhoneItem,
} from "../phone-drop";
import { IS_WINDOWS } from "../hotkeys";
import type { ProjectDto } from "../types";
import { toast } from "../toast";

const KIND_ICON = {
  image: ImageIcon,
  pdf: FileText,
  file: File,
  text: MessageSquareText,
} as const;

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** 列表缩略图：原图经白名单读一次、画成 96px 小图后只留小图（手机照片几 MB，整张进内存不划算）；
 *  读不了的（HEIC 等）记 null，行里显示类型图标 */
const thumbCache = new Map<string, string | null>();

function makeThumb(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 96;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => reject(new Error("decode"));
    img.src = dataUrl;
  });
}

function usePhoneThumbs(items: PhoneItem[], active: boolean): Record<string, string | null> {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stale = false;
    const todo = items.filter((it) => it.kind === "image" && it.path && !thumbCache.has(it.id)).slice(0, 40);
    for (const it of todo) {
      thumbCache.set(it.id, null);
      void invoke<{ mime: string; data: string }>("read_image_bytes", { path: it.path })
        .then((img) => makeThumb(`data:${img.mime};base64,${img.data}`))
        .then((thumb) => {
          thumbCache.set(it.id, thumb);
          if (!stale) bump((n) => n + 1);
        })
        .catch(() => undefined);
    }
    return () => {
      stale = true;
    };
  }, [items, active]);
  return Object.fromEntries(items.map((it) => [it.id, thumbCache.get(it.id) ?? null]));
}

/** 「从手机添加」弹层（App 全局挂一处；入口：聊天输入框「+」、命令面板、收件箱「手机」）。
 *  有已配对的手机时上面只是一张状态卡（二维码收进「配对新手机」）；下面「收到的」带缩略图，点开就地预览。 */
export default function PhoneDropDialog() {
  const open = usePhoneDropStore((s) => s.open);
  const target = usePhoneDropStore((s) => s.target);
  const status = usePhoneDropStore((s) => s.status);
  const incoming = usePhoneDropStore((s) => s.incoming);
  const error = usePhoneDropStore((s) => s.error);
  const starting = usePhoneDropStore((s) => s.starting);
  const items = usePhoneDropStore((s) => s.items);
  const closeDialog = usePhoneDropStore((s) => s.closeDialog);
  const start = usePhoneDropStore((s) => s.start);
  const stop = usePhoneDropStore((s) => s.stop);
  const patchItem = usePhoneDropStore((s) => s.patchItem);
  const removeItem = usePhoneDropStore((s) => s.removeItem);
  const deliver = usePhoneDropStore((s) => s.deliver);
  const devices = usePhoneDropStore((s) => s.devices);
  const removeDevice = usePhoneDropStore((s) => s.removeDevice);
  const setStandby = usePhoneDropStore((s) => s.setStandby);

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [placeRoot, setPlaceRoot] = useState<string>("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  // 预览弹窗与本弹层都认 Esc：同一次 Esc 只关预览（本弹层的 onClose 读到的还是打开时的值）
  const previewRef = useRef<string | null>(null);
  previewRef.current = previewId;

  useEffect(() => {
    if (!open) return;
    setPairOpen(false);
    setDevicesOpen(false);
    setPreviewId(null);
    let stale = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (stale) return;
        setProjects(list);
        setPlaceRoot(pickPlaceProject(list, target?.cwd ?? null, IS_WINDOWS) ?? "");
      })
      .catch(() => {
        if (!stale) setProjects([]);
      });
    return () => {
      stale = true;
    };
  }, [open, target?.cwd]);

  const placeable = useMemo(() => placeableProjects(projects), [projects]);
  const thumbs = usePhoneThumbs(items, open);
  const qrSrc = status.qrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(status.qrSvg)}` : null;
  const composerMode = Boolean(target);
  const paired = devices.length > 0;
  const showQr = status.receiving && qrSrc !== null && (!paired || pairOpen);
  const fileItems = items.filter((it) => it.path);
  const previewIndex = fileItems.findIndex((it) => it.id === previewId);
  const previewItem = previewIndex >= 0 ? fileItems[previewIndex] : null;
  const canPlaceAny = Boolean(placeRoot) && items.some((it) => it.kind !== "file" && it.status !== "placed");

  async function place(item: PhoneItem) {
    if (!placeRoot) return;
    setBusyId(item.id);
    try {
      const r = await invoke<{ relPath: string; dedup: boolean; item: PhoneItem }>("phone_drop_place", {
        id: item.id,
        projectRoot: placeRoot,
      });
      patchItem(r.item);
      toast(r.dedup ? `项目里已有同一份：${r.relPath}` : `已放进 ${r.relPath}`, "success");
    } catch (e) {
      toast(`没放进去：${String(e)}`, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function saveAs(item: PhoneItem) {
    try {
      const dest = await saveDialog({ defaultPath: item.name });
      if (!dest) return;
      const updated = await invoke<PhoneItem>("phone_drop_save_as", { id: item.id, dest });
      patchItem(updated);
      toast("已另存", "success");
    } catch (e) {
      toast(`另存失败：${String(e)}`, "error");
    }
  }

  async function remove(item: PhoneItem) {
    try {
      await invoke("phone_drop_delete", { id: item.id });
      removeItem(item.id);
      thumbCache.delete(item.id);
      if (previewId === item.id) setPreviewId(null);
    } catch (e) {
      toast(`删除失败：${String(e)}`, "error");
    }
  }

  function copyText(item: PhoneItem) {
    void navigator.clipboard
      .writeText(item.text ?? "")
      .then(() => toast("已复制", "success"))
      .catch(() => toast("复制失败", "error"));
  }

  function openItem(item: PhoneItem) {
    if (item.kind === "text") {
      setExpandedText((cur) => (cur === item.id ? null : item.id));
      return;
    }
    if (item.path) setPreviewId(item.id);
  }

  /** 预览弹窗右下角的一个后续动作：能放进项目就放，否则能附到输入框就附 */
  function previewAction(item: PhoneItem): { label: string; onClick: () => void } | undefined {
    const actions = phoneItemActions(item, { canAttach: composerMode, canPlace: Boolean(placeRoot) });
    if (actions.includes("place")) return { label: "放进项目", onClick: () => void place(item) };
    if (actions.includes("attach")) return { label: "附到输入框", onClick: () => deliver(item) };
    return undefined;
  }

  const card = phonePairedCard(status, incoming);
  const footer = !status.receiving ? (
    <button type="button" className={secondaryActionClass} onClick={closeDialog}>
      关闭
    </button>
  ) : composerMode ? (
    <>
      <button type="button" className={secondaryActionClass} onClick={() => void stop()}>
        停止接收
      </button>
      <button type="button" className={primaryActionClass} onClick={closeDialog}>
        收起
      </button>
    </>
  ) : (
    <>
      <span className="mr-auto text-micro text-l4">
        {paired && status.standbyEnabled ? "关掉后配对过的手机照样能发" : "关掉就停止接收"}
      </span>
      <button type="button" className={primaryActionClass} onClick={closeDialog}>
        完成
      </button>
    </>
  );

  return (
    <>
      <Modal
        open={open}
        title="从手机添加"
        onClose={() => {
          if (previewRef.current) return;
          closeDialog();
        }}
        size="md"
        footer={footer}
        contentClassName="text-xs"
      >
        <div className="space-y-4">
          {error && <InlineNotice tone="err">{error}</InlineNotice>}
          {status.receiving && status.portNote && <InlineNotice tone="warn">{status.portNote}</InlineNotice>}

          {paired ? (
            <div className={projectWellClass}>
              <div className="flex items-center gap-3">
                <Smartphone
                  size={18}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  className={`shrink-0 ${card.live ? "text-ok-text" : "text-l3"}`}
                />
                <div className="min-w-0 flex-1 leading-5">
                  <p className={`text-sm ${card.live ? "text-ok-text" : "text-l1"}`}>{card.title}</p>
                  {card.hint && <p className="text-l3">{card.hint}</p>}
                </div>
                {!status.receiving && !status.standby ? (
                  <button
                    type="button"
                    className={secondaryActionClass}
                    disabled={starting}
                    onClick={() => void start()}
                  >
                    {starting ? "正在开始…" : "开始接收"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={ghostActionClass}
                    disabled={starting}
                    onClick={() => {
                      // 配新手机要二维码：常驻等候没有，先转成主动接收
                      if (!status.receiving) void start().then(() => setPairOpen(true));
                      else setPairOpen((v) => !v);
                    }}
                  >
                    {status.receiving && pairOpen ? "收起二维码" : "配对新手机"}
                  </button>
                )}
              </div>
              <label className="mt-2.5 flex items-center gap-2 border-t border-hairline pt-2.5 text-l3">
                <Toggle
                  checked={status.standbyEnabled}
                  onChange={(v) => void setStandby(v)}
                  label="Mesa 开着就随时接收"
                />
                <span>
                  Mesa 开着就随时接收，收到的自动弹出这里
                  {!status.standbyEnabled && "（关着时要先点「开始接收」）"}
                </span>
              </label>
            </div>
          ) : (
            !status.receiving && (
              <div className="flex items-center gap-3">
                <p className="flex-1 text-l3">{starting ? "正在开始接收…" : "没有在接收。"}</p>
                {!starting && (
                  <button type="button" className={secondaryActionClass} onClick={() => void start()}>
                    开始接收
                  </button>
                )}
              </div>
            )
          )}

          {showQr && (
            <div className="flex gap-4">
              <div className="shrink-0 rounded-lg bg-white p-1.5">
                <img src={qrSrc ?? undefined} alt="扫码打开手机上传页" className="size-36" />
              </div>
              <div className="min-w-0 flex-1 space-y-2 leading-5">
                <p className="text-sm text-l1">用手机相机扫这个码。</p>
                <p className="text-l3">
                  手机和电脑要连同一个 Wi-Fi。扫开后就记住这台手机，照页面提示加到主屏幕，以后不用再扫。
                </p>
                {!paired && (
                  <p className={status.connected ? "text-ok-text" : "text-l3"}>{phoneStateLine(status, incoming)}</p>
                )}
                {status.url && (
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-micro text-l4" title={status.url}>
                      {status.url}
                    </span>
                    <button
                      type="button"
                      className={ghostActionClass}
                      title="复制地址（扫不了码时在手机浏览器里手动输入）"
                      aria-label="复制地址"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(status.url ?? "")
                          .then(() => toast("已复制地址", "success"))
                          .catch(() => toast("复制失败", "error"))
                      }
                    >
                      <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {status.addresses.length > 1 && (
                  <div className="w-full max-w-72">
                    <MenuSelect
                      aria-label="换一个地址"
                      value={status.host ?? ""}
                      onChange={(host) => {
                        if (host !== status.host) void start(host);
                      }}
                      options={status.addresses.map((a) => ({ value: a.host, label: a.label }))}
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-l3 hover:text-l1"
                  onClick={() => setHelpOpen((v) => !v)}
                  aria-expanded={helpOpen}
                >
                  <FoldMark open={helpOpen} />
                  扫了打不开？
                </button>
              </div>
            </div>
          )}
          {showQr && helpOpen && (
            <ul className="list-disc space-y-1 pl-5 leading-5 text-l3">
              <li>确认手机和电脑连的是同一个 Wi-Fi；手机开着 VPN 的话先关掉。</li>
              <li>校园网、公司网常禁止设备互访：让电脑连手机热点，再点「停止接收」「开始接收」，扫新码。</li>
              <li>
                电脑弹出防火墙提示时点允许。Windows 上要勾「专用网络」，并把当前 Wi-Fi 设成专用网络——新连的 Wi-Fi
                常被归为公用，只勾专用会照样被拦。
              </li>
              <li>
                地址有两种：电脑名（xxx.local）换了 Wi-Fi 也能连；IP 地址一变就要重扫。手机打不开电脑名时，用上面的下拉换成
                IP 再扫。
              </li>
            </ul>
          )}

          {paired && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-l3 hover:text-l1"
                onClick={() => setDevicesOpen((v) => !v)}
                aria-expanded={devicesOpen}
              >
                <FoldMark open={devicesOpen} />
                已配对的手机
                <span className="text-l4">{devices.length} 台</span>
              </button>
              {devicesOpen && (
                <ul className="mt-1.5 space-y-0.5">
                  {devices.map((d) => (
                    <li key={d.id} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                      <Smartphone size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                      <span className="min-w-0 truncate text-l1">{d.name}</span>
                      <span className="min-w-0 flex-1 truncate text-micro text-l4">{phoneDeviceLine(d, new Date())}</span>
                      <button
                        type="button"
                        className={ghostActionClass}
                        title="移除后它主屏上的「发到 Mesa」就失效了，要再用得重新扫码"
                        onClick={() => void removeDevice(d.id)}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-medium text-l2">收到的</span>
              <span className="text-l4">点开看 · 保留 7 天</span>
              {placeable.length > 0 && canPlaceAny && (
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-l4">放进</span>
                  <div className="w-44">
                    <MenuSelect
                      aria-label="放进哪个项目"
                      value={placeRoot}
                      onChange={setPlaceRoot}
                      options={placeable.map((p) => ({ value: p.path, label: p.name }))}
                    />
                  </div>
                </div>
              )}
            </div>
            {items.length === 0 ? (
              <p className="py-3 text-l4">还没有。手机上发出的东西会马上出现在这里。</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {items.map((item) => {
                  const Icon = KIND_ICON[item.kind] ?? File;
                  const thumb = thumbs[item.id];
                  const actions = phoneItemActions(item, {
                    canAttach: composerMode,
                    canPlace: Boolean(placeRoot),
                  });
                  const note = phoneItemStatusText(item);
                  const openable = phoneItemOpenable(item);
                  const expanded = expandedText === item.id;
                  return (
                    <li key={item.id} className="rounded-md hover:bg-hover">
                      <div className="flex min-w-0 items-center gap-2.5 px-1.5 py-1">
                        <button
                          type="button"
                          disabled={!openable}
                          onClick={() => openItem(item)}
                          title={item.kind === "text" ? (expanded ? "收起" : "展开全文") : "预览"}
                          className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-hairline bg-strip"
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className="size-full object-cover" />
                          ) : (
                            <Icon size={16} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={!openable}
                          onClick={() => openItem(item)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-l1" title={item.text ?? item.name}>
                            {item.name}
                          </span>
                          <span className="block truncate text-micro text-l4" title={item.placedTo ?? undefined}>
                            {[
                              item.kind === "text" ? null : formatPhoneSize(item.size),
                              timeLabel(item.receivedAt),
                              note || null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {actions.includes("attach") && (
                            <button type="button" className={ghostActionClass} onClick={() => deliver(item)}>
                              附到输入框
                            </button>
                          )}
                          {actions.includes("place") && item.kind !== "file" && (
                            <button
                              type="button"
                              className={ghostActionClass}
                              disabled={busyId === item.id}
                              title={`放进项目的 ${PHONE_PLACE_TARGET[item.kind]}`}
                              onClick={() => void place(item)}
                            >
                              {busyId === item.id ? "放进中…" : "放进项目"}
                            </button>
                          )}
                          {actions.includes("saveAs") && (
                            <button type="button" className={ghostActionClass} onClick={() => void saveAs(item)}>
                              另存为…
                            </button>
                          )}
                          {actions.includes("copy") && (
                            <button type="button" className={ghostActionClass} onClick={() => copyText(item)}>
                              复制
                            </button>
                          )}
                          <button
                            type="button"
                            className={ghostActionClass}
                            title="删除"
                            aria-label="删除"
                            onClick={() => void remove(item)}
                          >
                            <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      {expanded && item.text && (
                        <p className="mx-1.5 mb-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-strip px-2.5 py-2 text-xs leading-5 text-l2">
                          {item.text}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="text-micro text-l4">只在同一网络内传输，没有加密。在公共 Wi-Fi 上别传敏感文件。</p>
        </div>
      </Modal>
      {previewItem?.path && (
        <OfficePreviewModal
          path={previewItem.path}
          root={dirOf(previewItem.path)}
          displayName={previewItem.name}
          onClose={() => setPreviewId(null)}
          extraAction={previewAction(previewItem)}
          hasPrevious={previewIndex > 0}
          hasNext={previewIndex < fileItems.length - 1}
          onPrevious={() => setPreviewId(fileItems[previewIndex - 1]?.id ?? null)}
          onNext={() => setPreviewId(fileItems[previewIndex + 1]?.id ?? null)}
        />
      )}
    </>
  );
}
