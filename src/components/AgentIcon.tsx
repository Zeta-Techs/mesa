import { useId } from "react";
import claudeCode from "../assets/agent-icons/claude-code.svg?raw";
import codex from "../assets/agent-icons/codex.svg?raw";
import gemini from "../assets/agent-icons/gemini.svg?raw";
import qwen from "../assets/agent-icons/qwen.svg?raw";
import opencode from "../assets/agent-icons/opencode.svg?raw";
import kimi from "../assets/agent-icons/kimi.svg?raw";
import codebuddy from "../assets/agent-icons/codebuddy.svg?raw";
import cursor from "../assets/agent-icons/cursor.svg?raw";
import grok from "../assets/agent-icons/grok.svg?raw";

/** 九家 Agent 的产品图标（lobe-icons，MIT；指示性使用，许可见 docs/licenses/THIRD-PARTY.md）。 */
const RAW: Record<string, string> = {
  "claude-code": claudeCode,
  codex,
  gemini,
  qwen,
  opencode,
  kimi,
  codebuddy,
  cursor,
  grok,
};

/**
 * Agent 官方图标（连接页左栏、Agent 节标题用，2026-10-29 用户：「前面用各家的官方图标，不要用点」）。
 * 内联 SVG 而不是 <img>：OpenCode / Cursor / Grok 与 Kimi 的一部分是 currentColor，要跟着文字色走深浅主题；
 * 每个实例把渐变 id 换成自己的前缀，同页多处出现时不互相引用（被隐藏的那份会让渐变失效）。
 * 认不出的 Agent 给首字占位，保证一列图标位等宽。
 */
export default function AgentIcon({
  agent,
  label,
  size = 16,
  className = "",
}: {
  agent: string;
  /** 首字占位用 */
  label: string;
  size?: number;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const raw = RAW[agent];
  const box = `inline-flex shrink-0 items-center justify-center ${className}`;
  if (!raw) {
    const ch = Array.from(label.trim())[0]?.toUpperCase() ?? "·";
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={`${box} rounded-sm border border-hairline text-micro font-medium leading-none text-l4`}
      >
        {ch}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size }}
      className={`${box} [&>svg]:block`}
      dangerouslySetInnerHTML={{ __html: raw.split("lobe-icons-").join(`agent-icon-${uid}-`) }}
    />
  );
}
