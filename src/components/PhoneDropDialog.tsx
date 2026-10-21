import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, File, FileText, Image as ImageIcon, MessageSquareText, Smartphone, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import {
  FoldMark,
  InlineNotice,
  MenuSelect,
  ghostActionClass,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { usePhoneDropStore } from "../phone-drop-store";
import {
  PHONE_PLACE_TARGET,
  formatPhoneSize,
  phoneDeviceLine,
  phoneItemActions,
  phoneItemStatusText,
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

/** 「从手机添加」弹层（App 全局挂一处；入口：聊天输入框「+」、命令面板、收件箱「手机」）。 */
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

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [placeRoot, setPlaceRoot] = useState<string>("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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
  const qrSrc = status.qrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(status.qrSvg)}` : null;
  const composerMode = Boolean(target);

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

  const footer = status.receiving ? (
    <>
      <button type="button" className={secondaryActionClass} onClick={() => void stop()}>
        停止接收
      </button>
      <button type="button" className={primaryActionClass} onClick={closeDialog}>
        {composerMode ? "收起" : "完成"}
      </button>
    </>
  ) : (
    <button type="button" className={secondaryActionClass} onClick={closeDialog}>
      关闭
    </button>
  );

  return (
    <Modal
      open={open}
      title="从手机添加"
      onClose={closeDialog}
      size="md"
      footer={footer}
      contentClassName="text-xs"
    >
      <div className="space-y-4">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {status.receiving && status.portNote && <InlineNotice tone="warn">{status.portNote}</InlineNotice>}

        {status.receiving && qrSrc ? (
          <div className="flex gap-4">
            <div className="shrink-0 rounded-lg bg-white p-1.5">
              <img src={qrSrc} alt="扫码打开手机上传页" className="size-40" />
            </div>
            <div className="min-w-0 flex-1 space-y-2 leading-5">
              <p className="text-sm text-l1">
                {devices.length > 0 ? "已配对的手机直接打开主屏幕上的「发到 Mesa」。" : "用手机相机扫这个码。"}
              </p>
              <p className="text-l3">
                {devices.length > 0
                  ? "新手机扫这个码，扫开就记住了。手机和电脑要连同一个 Wi-Fi。"
                  : "手机和电脑要连同一个 Wi-Fi。扫开后就记住这台手机，可以加到主屏幕，以后不用再扫。"}
              </p>
              <p className={status.connected ? "text-ok-text" : "text-l3"}>
                {phoneStateLine(status, incoming, devices.length > 0)}
              </p>
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
                <div className="w-72 max-w-full">
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
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-l3">{starting ? "正在开始接收…" : "没有在接收。"}</p>
            {!starting && (
              <button type="button" className={secondaryActionClass} onClick={() => void start()}>
                开始接收
              </button>
            )}
          </div>
        )}

        <div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-l3 hover:text-l1"
            onClick={() => setHelpOpen((v) => !v)}
            aria-expanded={helpOpen}
          >
            <FoldMark open={helpOpen} />
            扫了打不开？
          </button>
          {helpOpen && (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 leading-5 text-l3">
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
              <li>已配对的手机打开后显示「电脑那边没在接收」：先在这里开始接收，手机页会自动连上。</li>
            </ul>
          )}
        </div>

        {devices.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-medium text-l2">已配对的手机</span>
              <span className="text-l4">移除后它主屏上的「发到 Mesa」就失效了</span>
            </div>
            <ul className="space-y-0.5">
              {devices.map((d) => (
                <li key={d.id} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                  <Smartphone size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                  <span className="min-w-0 truncate text-l1">{d.name}</span>
                  <span className="min-w-0 flex-1 truncate text-micro text-l4">{phoneDeviceLine(d, new Date())}</span>
                  <button type="button" className={ghostActionClass} onClick={() => void removeDevice(d.id)}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-medium text-l2">收到的</span>
            <span className="text-l4">保留 7 天</span>
            {placeable.length > 0 && items.some((it) => it.kind !== "file") && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-l4">放进</span>
                <div className="w-48">
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
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {items.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? File;
                const actions = phoneItemActions(item, {
                  canAttach: composerMode,
                  canPlace: Boolean(placeRoot),
                });
                const note = phoneItemStatusText(item);
                return (
                  <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                    <Icon size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-l1" title={item.text ?? item.name}>
                        {item.name}
                      </div>
                      <div className="truncate text-micro text-l4">
                        {[
                          item.kind === "text" ? null : formatPhoneSize(item.size),
                          timeLabel(item.receivedAt),
                          note || null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-micro text-l4">只在同一网络内传输，没有加密。在公共 Wi-Fi 上别传敏感文件。</p>
      </div>
    </Modal>
  );
}
