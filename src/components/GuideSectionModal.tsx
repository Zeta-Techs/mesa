import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import { ghostActionClass, secondaryActionClass } from "./PageFrame";
import ChatMarkdown from "./ChatMarkdown";
import { guideAnchor } from "../project-assistant";
import { userGuideUrl } from "../help-links";
import { toast } from "../toast";

/**
 * 在应用里看说明书的一节（2026-11-04：项目助手「依据」里点小节名原来跳 GitHub 上的最新版——
 * 可能和装的版本对不上、离线打不开）。说明书随应用打包，后端 assistant_guide_section 取这一节原文。
 */
export default function GuideSectionModal({ heading, onClose }: { heading: string | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!heading) return;
    let stale = false;
    setText(null);
    setMissing(false);
    void invoke<string | null>("assistant_guide_section", { heading })
      .then((t) => {
        if (stale) return;
        if (t) setText(t.replace(/^#{1,6}\s+.*\n?/, ""));
        else setMissing(true);
      })
      .catch(() => {
        if (!stale) setMissing(true);
      });
    return () => {
      stale = true;
    };
  }, [heading]);
  return (
    <Modal
      open={!!heading}
      onClose={onClose}
      size="lg"
      layer="overlay"
      title={`说明书 · ${heading ?? ""}`}
      description="随这一版 Mesa 打包的说明书原文"
      footer={
        <>
          <button
            type="button"
            className={ghostActionClass}
            onClick={() => heading && void openUrl(userGuideUrl(guideAnchor(heading))).catch(() => toast("浏览器没打开，稍后再试", "warning"))}
          >
            在浏览器里看最新版
          </button>
          <button type="button" className={secondaryActionClass} onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {missing ? (
        <p className="text-sm text-l3">这一版的说明书里没找到这一节（可能改过名），可以在浏览器里看最新版。</p>
      ) : text === null ? (
        <p className="text-sm text-l3">正在打开…</p>
      ) : (
        <div className="text-sm text-l1">
          <ChatMarkdown text={text} />
        </div>
      )}
    </Modal>
  );
}
