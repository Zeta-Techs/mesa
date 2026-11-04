import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { subscribeToastDismiss, subscribeToastPatch, subscribeToasts, type ToastNotice } from "../toast";
import { noticeDurationMs, splitNoticeText } from "../notice-text";
import { compactPrimaryActionClass, rowActionClass } from "./PageFrame";

export default function ToastHost() {
  const [items, setItems] = useState<ToastNotice[]>([]);
  /** 每条会自动消失的提示的计时器（补了按钮的要重新计时，多留一会儿） */
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    const unsubscribe = subscribeToasts((notice) => {
      // 同 key 的新提示顶替旧的；常驻的不挤（满员时先挤最旧的会自动消失的那条）
      setItems((current) => {
        const kept = notice.key
          ? current.filter((item) => item.key !== notice.key)
          : current;
        const next = [...kept, notice];
        while (next.length > 4) {
          const disposable = next.findIndex((item) => !item.sticky);
          next.splice(disposable >= 0 ? disposable : 0, 1);
        }
        return next;
      });
      if (notice.sticky) return;
      // 长说明按字数多留一会儿（原来一律 3.2 秒，长句还没读完就消失）
      timers.current.set(
        notice.id,
        window.setTimeout(() => {
          timers.current.delete(notice.id);
          setItems((current) => current.filter((item) => item.id !== notice.id));
        }, noticeDurationMs(notice.message, notice.tone)),
      );
    });
    const unsubscribePatch = subscribeToastPatch((id, actions) => {
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, actions: [...(item.actions ?? []), ...actions] } : item)),
      );
      const old = timers.current.get(id);
      if (old === undefined) return;
      window.clearTimeout(old);
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          setItems((current) => current.filter((item) => item.id !== id));
        }, 12_000),
      );
    });
    const unsubscribeDismiss = subscribeToastDismiss((key) => {
      setItems((current) => current.filter((item) => item.key !== key));
    });
    return () => {
      unsubscribe();
      unsubscribeDismiss();
      unsubscribePatch();
    };
  }, []);

  const remove = (id: number) =>
    setItems((current) => current.filter((entry) => entry.id !== id));

  return (
    <div className="ccode-toast-region" role="region" aria-label="通知" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === "error" ? "alert" : "status"}
          className={`ccode-toast ccode-toast-${item.tone}`}
        >
          {(() => {
            // 与提示条同一套分层：首句是结果，其余是说明
            const parts = splitNoticeText(item.message);
            return (
              <div className="ccode-toast-body">
                <span className={parts.details.length ? "ccode-toast-headline" : undefined}>
                  {item.busy && (
                    <LoaderCircle
                      size={13}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="mr-1.5 inline-block animate-spin align-[-2px] text-l3"
                    />
                  )}
                  {parts.headline}
                </span>
                {parts.details.map((line, i) => (
                  <span key={i} className="ccode-toast-detail">
                    {line}
                  </span>
                ))}
                {item.actions && item.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    {item.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className={action.primary ? compactPrimaryActionClass : rowActionClass}
                        onClick={() => {
                          remove(item.id);
                          action.onClick();
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <button
            type="button"
            aria-label="关闭提示"
            className="ccode-toast-close"
            onClick={() => remove(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
