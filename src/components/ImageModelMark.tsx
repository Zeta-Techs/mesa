import { Palette } from "lucide-react";
import VendorIcon from "./VendorIcon";
import { vendorForModel } from "../vendor-icon";

/** Tailwind 只生成源码里写全的类名，尺寸按档位写死 */
const SIZE_CLASS: Record<12 | 13 | 14, string> = { 12: "size-3", 13: "size-[13px]", 14: "size-3.5" };

/**
 * 聊天出图模式里出图模型的标识（2026-11-24 用户选）：认得出厂商就画厂商标识（gpt-image → OpenAI、gemini-*-image → Gemini，
 * 同连接页出图块与左栏）；认不出（Flux 等）或还没选用调色盘——读作「画图」，不画通用图片图标（放在「+」旁边像附件里的一张图）。
 * 用在输入框出图胶囊、「+」菜单「画图」、消息上方「出图 · 模型」那行。
 */
export default function ImageModelMark({
  model,
  size = 13,
  className = "",
}: {
  model: string | null | undefined;
  size?: 12 | 13 | 14;
  className?: string;
}) {
  const vendor = vendorForModel(model);
  if (vendor) return <VendorIcon vendor={vendor} name={model ?? ""} className={`${SIZE_CLASS[size]} ${className}`} />;
  return <Palette size={size} strokeWidth={1.8} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
