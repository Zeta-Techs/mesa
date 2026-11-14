/**
 * 能力清单的「干活的连接」与「定时与事件」两块（2026-11-05 接活二期，docs/design-assistant-intake.md §4）。
 * 项目助手据此在起草时说清这件活能做到哪一步：连接看不了图、没配出图模型、不能无头写盘时，做不到的部分直说，
 * 单子只派做得到的。数据全部来自已有来源（agent_capabilities 能力表、model_capabilities 能力库、设置里的出图模型、
 * image_gen_status），不在这里另抄名单。纯逻辑，配 tests/assistant-capabilities.test.ts。
 */

export interface WorkerCapabilityInput {
  /** 干活的连接：Agent 展示名、连接名、模型；没有可用连接为 null */
  worker: { agent: string; profile: string; model: string } | null;
  headlessWrite: { supported: boolean; reason?: string } | null;
  /** 模型能不能看图：true / false / null（能力库查不到） */
  vision: boolean | null;
  /** 设置里选的出图模型（空 = 没选）与随包出图工具在不在 */
  imageGen: { model: string | null; helperReady: boolean };
  /** 支持分级：1 一等 / 2 维护级，附悬停人话 */
  tier: { level: 1 | 2; note: string } | null;
  /** 单独绑了与项目默认不同的连接或模型的步骤（派给那一步时以它为准） */
  stepBindings?: readonly {
    n: number;
    name: string;
    agent: string;
    profile: string;
    model: string;
    vision?: boolean | null;
  }[];
}

function formatStepBindings(stepBindings: WorkerCapabilityInput["stepBindings"], header: string): string[] {
  if (!stepBindings?.length) return [];
  const out = [header];
  for (const b of stepBindings) {
    const vis = b.vision === true ? "，能看图" : b.vision === false ? "，不能看图" : "";
    out.push(`  · 第 ${b.n} 步「${b.name}」：${b.agent} · ${b.profile} · ${b.model || "默认模型"}${vis}`);
  }
  return out;
}

export function workerCapabilityLines(input: WorkerCapabilityInput): string[] {
  const { worker } = input;
  if (!worker) {
    return [
      "干活的连接：这个项目还没有能用的连接（派不出去，先请用户到连接页配一个，或在 Agent 分工里定项目默认）。",
      ...formatStepBindings(input.stepBindings, "- 各步单独绑定的干活连接（交给这几步照常能派）："),
    ];
  }
  const lines = [
    `干活的连接（派成新目标时用项目默认；交给第 N 步时用那一步自己绑的，可能不同）：${worker.agent} · ${worker.profile} · ${worker.model || "默认模型"}`,
  ];
  if (input.tier) {
    lines.push(
      input.tier.level === 1
        ? "- 支持程度：一等支持，Mesa 的功能都在这家上做全了。"
        : `- 支持程度：维护级（${input.tier.note || "新功能尽力而为"}）。`,
    );
  }
  lines.push(
    input.vision === true
      ? "- 看图：能（截图、照片、扫描版 PDF 里的图都看得到）。"
      : input.vision === false
        ? "- 看图：不能。要从照片、截图、扫描版 PDF 的图里读数据的活，它做不到——请用户给文字版或数据文件，或说明这部分要人来做。"
        : "- 看图：不确定（能力库查不到这个模型）。要靠看图的活写进「先定下的假设」，并写明看不了图时先停下来问。",
  );
  const { imageGen } = input;
  lines.push(
    imageGen.model && imageGen.helperReady
      ? `- 出图（按描述画示意插画、封面一类）：能，用设置里选的出图模型 ${imageGen.model}。数据图一律用脚本画，不走出图。`
      : imageGen.model
        ? "- 出图：设置里选了出图模型，但这台电脑上的出图工具没找到，这次画不了示意插画；数据图照样能用脚本画。"
        : "- 出图：设置里没选出图模型，按描述画示意插画做不了（用户可以到连接页配一个出图模型）；数据图照样能用脚本画。",
  );
  const hw = input.headlessWrite;
  lines.push(
    !hw
      ? "- 定时任务：查不到这家能不能在后台写文件，提到定时时请用户自己在定时任务页看能不能选它。"
      : hw.supported
        ? `- 定时任务：这条连接能在后台写文件，可以用来建定时任务${hw.reason ? `（注意：${hw.reason}）` : ""}。`
        : `- 定时任务：这条连接不能在后台写文件（${hw.reason || "没验证过"}），定时任务选不了它，要换一条连接。`,
  );
  lines.push(...formatStepBindings(input.stepBindings, "- 各步单独绑定的干活连接（交给那一步时以它为准）："));
  return lines;
}

/** 定时与事件能做什么：项目助手只说明、不建；建由人到定时任务页或做成后点 */
export const TRIGGER_CATALOG_LINES: readonly string[] = [
  "定时与事件（你不建，只说明做成后用户可以在项目的「定时任务」页签里建）：",
  "- 定时任务：每天、每周某天、或每隔几小时跑一次；跑在隔离副本里，产物经评审才进项目。",
  "- 事件规则：项目里某个文件夹来了新文件、文献雷达有新命中、从手机添加了东西时触发；新建默认只记录，要直接跑由用户自己改。",
];
