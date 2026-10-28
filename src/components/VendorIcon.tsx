import anthropic from "../assets/vendor-icons/anthropic.svg";
import openai from "../assets/vendor-icons/openai.svg";
import deepseek from "../assets/vendor-icons/deepseek.svg";
import zhipu from "../assets/vendor-icons/zhipu.svg";
import kimi from "../assets/vendor-icons/kimi.svg";
import minimax from "../assets/vendor-icons/minimax.svg";
import alibaba from "../assets/vendor-icons/alibaba.svg";
import tencent from "../assets/vendor-icons/tencent.svg";
import openrouter from "../assets/vendor-icons/openrouter.svg";
import xai from "../assets/vendor-icons/xai.svg";
import ollama from "../assets/vendor-icons/ollama.svg";
import newapi from "../assets/vendor-icons/newapi.svg";
import gemini from "../assets/vendor-icons/gemini.svg";
import { isMonoVendor, type VendorId } from "../vendor-icon";

const SRC: Record<VendorId, string> = {
  anthropic,
  openai,
  deepseek,
  zhipu,
  kimi,
  minimax,
  alibaba,
  tencent,
  openrouter,
  xai,
  ollama,
  newapi,
  gemini,
};

/**
 * 厂商小图标，仅用于标明端点 / 套餐所属平台（指示性使用，许可见 docs/licenses/THIRD-PARTY.md）。
 * 单色图标用 mask 按文字色画（深浅主题都看得见）；认不出厂商的（自定义网关、第三方中转）给首字占位，
 * 保证一列里图标位等宽。
 */
export default function VendorIcon({
  vendor,
  name,
  className = "",
}: {
  vendor: VendorId | null;
  name: string;
  className?: string;
}) {
  const box = `inline-flex h-4 w-4 shrink-0 items-center justify-center ${className}`;
  if (!vendor) {
    const ch = Array.from(name.trim())[0]?.toUpperCase() ?? "·";
    return (
      <span
        aria-hidden
        className={`${box} rounded-sm border border-hairline text-micro font-medium leading-none text-l4`}
      >
        {ch}
      </span>
    );
  }
  if (isMonoVendor(vendor)) {
    const url = `url("${SRC[vendor]}")`;
    return (
      <span aria-hidden className={`${box} text-l2`}>
        <span
          className="block h-full w-full bg-current"
          style={{
            WebkitMaskImage: url,
            maskImage: url,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />
      </span>
    );
  }
  return <img src={SRC[vendor]} alt="" aria-hidden className={`${box} rounded-sm object-contain`} />;
}
