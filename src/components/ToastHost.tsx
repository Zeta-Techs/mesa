import { useEffect, useState } from "react";
import { subscribeToasts, type ToastNotice } from "../toast";
import { noticeDurationMs, splitNoticeText } from "../notice-text";

export default function ToastHost() {
  const [items, setItems] = useState<ToastNotice[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToasts((notice) => {
      setItems((current) => [...current, notice].slice(-4));
      // 长说明按字数多留一会儿（原来一律 3.2 秒，长句还没读完就消失）
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== notice.id));
      }, noticeDurationMs(notice.message, notice.tone));
    });
    return () => {
      unsubscribe();
    };
  }, []);

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
              <span className="ccode-toast-body">
                <span className={parts.details.length ? "ccode-toast-headline" : undefined}>
                  {parts.headline}
                </span>
                {parts.details.map((line, i) => (
                  <span key={i} className="ccode-toast-detail">
                    {line}
                  </span>
                ))}
              </span>
            );
          })()}
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() =>
              setItems((current) => current.filter((entry) => entry.id !== item.id))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
