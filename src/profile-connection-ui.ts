/** 连接行状态列文案、行上测试、「同步目录」是否出现、同组重名。 */

import { slotForAgent } from "./gateway-slot.ts";

export type ProfileStatusTone = "ok" | "warn" | "err" | "muted";

export interface ProfileStatus {
  text: string;
  tip: string;
  tone: ProfileStatusTone;
}

export const CONNECTION_STATUS_CAPTION: Record<
  string,
  [text: string, tip: string, tone: ProfileStatusTone]
> = {
  gateway_missing: ["网关缺失", "绑定的网关已不存在", "err"],
  slot_missing: ["缺槽", "这个网关还没配该协议的端点", "warn"],
  credential_missing: ["缺密钥", "网关未配置密钥且不是无密钥端点", "warn"],
  probe_failed: ["测试失败", "最近一次连接测试失败，请重新测试", "err"],
  catalog_stale: ["目录过期", "模型目录超过 7 天未刷新", "warn"],
  model_unsynced: ["模型不在目录", "绑定的模型已不在网关的模型目录里", "warn"],
  ready: ["测试通过", "最近一次连接测试通过", "ok"],
};

/** 状态列：**只说要人处理的例外**（2026-10-31 用户拍板，取代 10-23「例外 + 测过且通过」）。
 *  测试通过 / 未测试 / 状态未知 / 官方账号都是几乎每行都一样的事实，常驻只会把真正的问题淹掉——返回 null；
 *  能测的行（canProbeProfile，测过的也算）由调用方在悬停时给「测试」入口，刚点完测试的结果由调用方就地短暂显示。 */
export function profileStatusCell(profile: {
  accountType?: string;
  connectionStatus?: string;
  modelSyncStatus?: string;
  modelSyncNote?: string | null;
  hasKey?: boolean;
  keyHint?: string | null;
  /** 调用方用 unsyncedModels 算出的那几个模型；给了就点名，悬停说清该怎么办 */
  unsynced?: readonly string[];
}): ProfileStatus | null {
  if (profile.accountType === "official") return null;
  const status = profile.connectionStatus;
  // 绑定模型不在网关目录（2026-10-28 用户看不懂「模型未同步」）：点名是哪个、可能为什么、去哪改。
  // 刷新目录清不掉，只能在编辑里去掉或换一个，状态列点一下就打开编辑
  const modelGone =
    status === "model_unsynced" ||
    profile.modelSyncStatus === "stale" ||
    profile.modelSyncStatus === "missing";
  const lab = status ? CONNECTION_STATUS_CAPTION[status] : undefined;
  if (lab && status !== "ready" && status !== "model_unsynced") {
    return { text: lab[0], tip: lab[1], tone: lab[2] };
  }
  if (modelGone) {
    const names = profile.unsynced?.length ? profile.unsynced.join("、") : null;
    const what = names
      ? `${names} 已不在网关的模型目录里`
      : profile.modelSyncNote?.trim() || CONNECTION_STATUS_CAPTION.model_unsynced[1];
    return {
      text: CONNECTION_STATUS_CAPTION.model_unsynced[0],
      tip: `${what}，可能已下架或改了名，用它启动会报错。点这里打开编辑，把它去掉或换一个`,
      tone: "warn",
    };
  }
  // 走到这里的 lab 只剩 ready（测试通过）：正常不写字
  // 后端没算出状态的旧数据：只兜底「没有密钥」这一种例外
  if (!status && profile.hasKey === false) {
    return { text: "未设置密钥", tip: "尚未填写密钥", tone: "warn" };
  }
  return null;
}

/** 绑定模型里不在网关目录的那几个：目录里没有，或刷新后已标失效（stale）。目录为空（没拉过）时不判 */
export function unsyncedModels(
  models: readonly string[],
  catalog: readonly { id: string; status?: string }[] | null | undefined,
): string[] {
  if (!catalog || catalog.length === 0) return [];
  return models.filter((m) => {
    const hit = catalog.find((c) => c.id === m);
    return !hit || hit.status === "stale";
  });
}

/** 行上能不能直接测：API 连接、有网关、协议槽支持体检（Gemini / Cursor 槽后端不支持，见 probe_gateway_slot） */
export function canProbeProfile(profile: {
  agent: string;
  protocol?: string | null;
  accountType?: string;
  gatewayId?: string | null;
}): boolean {
  if (profile.accountType === "official" || !profile.gatewayId) return false;
  const slot = slotForAgent(profile.agent, profile.protocol);
  return slot !== "gemini" && slot !== "cursor";
}

/** 同一 agent 下名字重复的连接 id：列表里给它们补首个模型名，否则启动栏里分不清 */
export function duplicateNameIds(
  profiles: { id: string; agent: string; name: string }[],
): Set<string> {
  const groups = new Map<string, string[]>();
  for (const p of profiles) {
    const k = `${p.agent}\u0000${p.name.trim().toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), p.id]);
  }
  const out = new Set<string>();
  for (const ids of groups.values()) if (ids.length > 1) ids.forEach((id) => out.add(id));
  return out;
}

/** 「同步目录」只处理目录过期。绑定模型不在目录 / 已标失效，刷新目录清不掉，应去编辑勾选。 */
export function showCatalogSyncAction(profile: {
  accountType?: string;
  gatewayId?: string | null;
  connectionStatus?: string;
}): boolean {
  return (
    profile.accountType !== "official" &&
    Boolean(profile.gatewayId) &&
    profile.connectionStatus === "catalog_stale"
  );
}

/**
 * 添加连接时自动起的名字（2026-10-23 弹层审查，用户拍板：名称放最后、自动起）。
 * 底名取网关名 / 服务商名 / 地址主机名（官方账号叫「官方账号」）；这家 Agent 下已有同名连接时补「· 首个模型」，
 * 仍撞名就原样给出，由名称框下的重名提醒交给人改。没有底名返回空串（名称框照常要求手填）。
 */
export function suggestConnectionName(input: {
  base: string;
  firstModel?: string | null;
  takenNames: readonly string[];
}): string {
  const base = input.base.trim();
  if (!base) return "";
  const taken = new Set(input.takenNames.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const model = input.firstModel?.trim();
  return model ? `${base} · ${model}` : base;
}

/** 附加环境变量里像密钥的键（与 profiles.rs sensitive_env_name 的子串启发式同口径）：值非空才算。
 *  附加环境变量明文存在 profiles.json，不像连接密钥那样只进 0600 密钥文件，填了密钥要提醒挪到密钥栏 */
export function secretLikeEnvKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    const i = t.indexOf("=");
    if (!t || t.startsWith("#") || i <= 0) continue;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim();
    if (!val) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|AUTH/.test(key.toUpperCase())) out.push(key);
  }
  return out;
}
