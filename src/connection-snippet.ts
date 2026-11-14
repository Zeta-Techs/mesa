/** 编辑连接弹层「配置」视图的纯逻辑：表单 ⇄ 片段字段（渲染与解析在后端 connection_snippet.rs）。 */
import type { RequestPolicy, RoleModels } from "./types";

/** 与后端 SnippetFields 同形（camelCase） */
export interface SnippetFields {
  name: string;
  accountType: string;
  noAuth: boolean;
  baseUrl: string;
  keyHint: string | null;
  newKey: string | null;
  protocol: string | null;
  apiBackend: string | null;
  models: string[];
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
  headerEnv: Record<string, string>;
  extraEnv: Record<string, string>;
  roleModels: RoleModels | null;
}

export interface SnippetDto {
  format: "json" | "toml";
  language: string;
  file: string;
  text: string;
}

/** 弹层表单里与片段相关的那几项 */
export interface SnippetFormSlice {
  name: string;
  accountType: "api" | "official";
  noAuth: boolean;
  protocol: string | null;
  apiBackend: string | null;
  baseUrl: string;
  models: string[];
  roleModels: RoleModels;
  extraEnvText: string;
  requestPolicy: RequestPolicy;
  apiKey: string;
}

/** 「名=值」一行一条 → 对象（空行、# 注释、没有 = 的行跳过；与弹层 parseEnvLines 同口径） */
export function linesToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

export function mapToLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** 表单 → 片段字段。密钥：已存的给尾号；表单里刚填了新密钥的，占位写「新填」，切回来照旧保留表单里那把 */
export function fieldsFromForm(
  form: SnippetFormSlice,
  headerEnvText: string,
  keyHint: string | null,
): SnippetFields {
  const models = [...new Set(form.models.map((m) => m.trim()).filter(Boolean))];
  const roles = form.roleModels && Object.values(form.roleModels).some((v) => v != null) ? form.roleModels : null;
  return {
    name: form.name.trim(),
    accountType: form.accountType,
    noAuth: form.accountType === "api" && form.noAuth,
    baseUrl: form.accountType === "api" ? form.baseUrl.trim() : "",
    keyHint: form.apiKey ? "新填，保存后生效" : keyHint,
    newKey: null,
    protocol: form.protocol,
    apiBackend: form.apiBackend,
    models,
    temperature: form.requestPolicy.temperature,
    topP: form.requestPolicy.topP,
    maxOutputTokens: form.requestPolicy.maxOutputTokens,
    reasoningEffort: form.requestPolicy.reasoningEffort,
    headerEnv: linesToMap(headerEnvText),
    extraEnv: linesToMap(form.extraEnvText),
    roleModels: roles,
  };
}

/** 片段字段 → 表单（只改片段管的那几项；名字留空 = 不改名；没填新密钥 = 保留表单里原来的） */
export function applyFieldsToForm<F extends SnippetFormSlice>(
  form: F,
  fields: SnippetFields,
): { form: F; headerEnvText: string } {
  return {
    form: {
      ...form,
      name: fields.name || form.name,
      noAuth: form.accountType === "api" && fields.noAuth,
      protocol: fields.protocol ?? form.protocol,
      apiBackend: fields.apiBackend,
      baseUrl: form.accountType === "api" ? fields.baseUrl : form.baseUrl,
      models: fields.models,
      roleModels: (fields.roleModels ?? {}) as RoleModels,
      extraEnvText: mapToLines(fields.extraEnv),
      requestPolicy: {
        ...form.requestPolicy,
        temperature: fields.temperature,
        topP: fields.topP,
        maxOutputTokens: fields.maxOutputTokens,
        reasoningEffort: fields.reasoningEffort,
        headerEnv: fields.headerEnv,
      },
      apiKey: fields.newKey ?? form.apiKey,
    },
    headerEnvText: mapToLines(fields.headerEnv),
  };
}

/** 编辑已有连接时归网关管的字段（后端 ProfileStore::update 只改连接自己的名称 / 协议 / 名单 / 分工 / 附加环境变量；
 *  地址、密钥、无密钥、请求头、请求参数只走网关接口）。片段里照样显示，改了就拦下指去网关库，不悄悄丢掉 */
export function gatewayOwnedChanges(before: SnippetFields, after: SnippetFields): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (after.baseUrl !== before.baseUrl) out.push("地址");
  if (after.newKey) out.push("密钥");
  if (after.noAuth !== before.noAuth) out.push("无密钥");
  if (!same(after.headerEnv, before.headerEnv)) out.push("请求头");
  if (!same(after.temperature, before.temperature)) out.push("温度");
  if (!same(after.topP, before.topP)) out.push("top_p");
  if (!same(after.maxOutputTokens, before.maxOutputTokens)) out.push("输出上限");
  if (!same(after.reasoningEffort, before.reasoningEffort)) out.push("思考档");
  return out;
}

/** 「配置」视图的「打开文件」定位到哪个文件（与后端 global_config::editable_config_files 的 tag 同名）。
 *  Cursor 没有可编辑的配置文件，不给入口 */
export function snippetFileTag(agent: string): string | null {
  switch (agent) {
    case "claude-code":
    case "codebuddy":
    case "qwen":
    case "gemini":
    case "agy":
      return "settings.json";
    case "codex":
    case "kimi":
    case "grok":
      return "config.toml";
    case "opencode":
      return "opencode.json";
    default:
      return null;
  }
}
