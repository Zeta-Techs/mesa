import { useEffect, useRef, useSyncExternalStore } from "react";
import { CircleAlert, CircleHelp, Info, TriangleAlert } from "lucide-react";
import { dangerActionClass, primaryActionClass, secondaryActionClass } from "./PageFrame";
import {
  confirmKeyAction,
  inferConfirmText,
  parseConfirmMessage,
  type ConfirmTone,
} from "../confirm-dialog";
import { imeBlocksEnter } from "../ime-guard";

interface ConfirmRequest {
  message: string;
  danger: boolean;
  /** 调用方给的按钮文字；没给时危险操作从标题里推动词（inferConfirmText） */
  confirmText?: string;
  alert: boolean;
  focusCancel: boolean;
  resolve: (ok: boolean) => void;
}

// 模块级单请求状态：宿主组件经 useSyncExternalStore 订阅，不进全局 zustand store
let current: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function settle(ok: boolean) {
  const req = current;
  current = null;
  emit();
  req?.resolve(ok);
}

/**
 * 全局 promise 版内联确认框。
 * macOS WKWebView 未实现 JS 对话框委托（window.confirm 恒返回 false），确认一律走这里。
 * 同一时刻只有一个请求（调用方都是用户手势触发）；重复调用时旧请求按「取消」resolve false。
 */
export function confirmDialog(
  message: string,
  opts?: { danger?: boolean; confirmText?: string; focusCancel?: boolean },
): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = {
      message,
      danger: opts?.danger ?? false,
      confirmText: opts?.confirmText,
      alert: false,
      // 危险操作默认焦点在「取消」（HIG：破坏性动作不做默认按钮），顺手一个回车不会误删；
      // 调用方显式 focusCancel: false 仍可改回
      focusCancel: opts?.focusCancel ?? opts?.danger ?? false,
      resolve,
    };
    emit();
  });
}

/** 全局确认/提示框是否开着：外层捕获层快捷键（文件页方向键/Esc 等）要避让，
 *  Esc/Enter 归对话框自己处理 */
export function confirmDialogOpen(): boolean {
  return current !== null;
}

/** 单按钮提示框（「知道了」）；macOS 上 window.alert 静默无效，结果/错误提示一律走这里 */
export function alertDialog(message: string): Promise<void> {
  current?.resolve(false);
  return new Promise<void>((resolve) => {
    current = {
      message,
      danger: false,
      confirmText: "知道了",
      alert: true,
      focusCancel: false,
      resolve: () => resolve(),
    };
    emit();
  });
}

/** 宿主组件：在 App 根部挂载一次；z-70 压过评审覆盖层内的 z-60 弹层 */
export function ConfirmDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Esc = 取消；Enter 激活当前焦点按钮（默认焦点在确认钮）。
  // 捕获阶段拦截，避免触发遮罩下层的 Esc 快捷键。
  useEffect(() => {
    if (!req) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const action = confirmKeyAction({
        key: e.key,
        alert: req.alert,
        focusedIsCancel:
          Boolean(cancelRef.current) &&
          document.activeElement === cancelRef.current,
        enterBlocked: imeBlocksEnter({
          isComposing: e.isComposing,
          keyCode: e.keyCode,
          composingLock: false,
        }),
      });
      if (action === "none") return;
      e.preventDefault();
      e.stopPropagation();
      settle(action === "confirm");
    };
    window.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => {
      if (req.focusCancel) cancelRef.current?.focus();
      else confirmRef.current?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, [req]);

  if (!req) return null;
  const content = parseConfirmMessage(req.message);
  const confirmText = req.alert
    ? "知道了"
    : inferConfirmText(content.title, req.danger, req.confirmText);
  const Glyph = req.alert ? Info : req.danger ? TriangleAlert : CircleHelp;
  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/40 p-6 ccode-fade"
      onClick={() => settle(false)}
    >
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ccode-confirm-dialog-title"
        aria-describedby="ccode-confirm-dialog-message"
        className="w-full max-w-[28rem] rounded-lg border border-hairline ccode-float-surface p-5"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="flex items-start gap-3">
          {/* 图标说语气：危险＝警示三角（错误色淡底）、确认＝问号、提示＝信息 */}
          <span
            className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${
              req.danger ? "bg-err-text/12 text-err-text" : "bg-hover text-l3"
            }`}
            aria-hidden="true"
          >
            <Glyph size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2
              id="ccode-confirm-dialog-title"
              className={
                content.title
                  ? "text-sm font-semibold leading-6 text-l1"
                  : "sr-only"
              }
            >
              {content.title ??
                (req.alert ? "提示" : req.danger ? "危险操作确认" : "确认操作")}
            </h2>
            <div
              id="ccode-confirm-dialog-message"
              className={`space-y-3 text-sm leading-6 text-l2 ${content.title ? "mt-2" : ""}`}
            >
              {content.blocks.map((block, i) =>
                block.kind === "text" ? (
                  <p
                    key={i}
                    className={`whitespace-pre-wrap break-words ${
                      content.title ? "" : "text-l1"
                    }`}
                  >
                    {block.text}
                  </p>
                ) : block.kind === "facts" ? (
                  // 对照表：项在左（l3）、后果在右；后果按语气着色，一眼分出保留/可找回/彻底删除
                  <dl
                    key={i}
                    className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md ccode-well px-3 py-2.5 text-xs leading-5"
                  >
                    {block.rows.map((row) => (
                      <div key={row.key} className="contents">
                        <dt className="max-w-[13rem] break-words text-l3">{row.key}</dt>
                        <dd className={`break-words font-medium ${TONE[row.tone]}`}>
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p
                    key={i}
                    className="flex gap-2 rounded-md bg-hover px-3 py-2 text-xs leading-5 text-l2"
                  >
                    <CircleAlert
                      size={13}
                      strokeWidth={1.8}
                      className="mt-1 shrink-0 text-l3"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {block.text}
                    </span>
                  </p>
                ),
              )}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {!req.alert && (
            <button
              ref={cancelRef}
              type="button"
              onClick={() => settle(false)}
              className={`${widen(secondaryActionClass)} min-w-16`}
            >
              取消
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`${widen(req.danger ? dangerActionClass : primaryActionClass)} min-w-16`}
            onClick={() => settle(true)}
          >
            {confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

/** 对话框按钮比行内按钮略宽（px-3 → px-3.5）：替换而非追加——Tailwind 同属性类按样式表顺序生效，追加不保证覆盖 */
function widen(cls: string): string {
  return cls.replace(/\bpx-3\b/, "px-3.5");
}

const TONE: Record<ConfirmTone, string> = {
  safe: "text-ok-text",
  danger: "text-err-text",
  neutral: "text-l1",
};
