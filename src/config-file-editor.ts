/** 连接页「编辑配置文件」的纯逻辑（弹层 ConfigFileEditorDialog 用；后端 config_editor.rs）。 */

/** 后端 ConfigFileDto：content 里的密钥已换成「已隐藏密钥」占位 */
export interface ConfigFileDto {
  tag: string;
  path: string;
  exists: boolean;
  language: string;
  content: string;
  revision: string;
  hiddenSecrets: number;
  error: string | null;
}

/** 格式化（只给严格 JSON）：解析失败如实说，不动原文 */
export function formatJsonText(text: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const value = JSON.parse(text);
    return { ok: true, text: `${JSON.stringify(value, null, 2)}\n` };
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON，没法格式化：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 底部说明：密钥怎么处理、文件不存在时会怎样 */
export function fileHint(file: ConfigFileDto): string {
  if (file.error) return file.error;
  const parts: string[] = [];
  if (!file.exists) parts.push("文件还不存在，保存后新建");
  if (file.hiddenSecrets > 0) {
    parts.push(`${file.hiddenSecrets} 处密钥显示为「已隐藏密钥」占位，保持不动即原样保存；要换密钥，把整个占位改成新值`);
  }
  parts.push("保存前自动备份，改坏了用 ⋯ 里的「撤销上次写入」回退");
  return parts.join("。") + "。";
}

/** 关掉前要确认的文件（有没保存的改动） */
export function dirtyTags(files: ConfigFileDto[], current: Record<string, string>): string[] {
  return files.filter((f) => current[f.tag] !== undefined && current[f.tag] !== f.content).map((f) => f.tag);
}
