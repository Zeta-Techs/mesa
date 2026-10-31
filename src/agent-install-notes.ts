/**
 * Windows 上装 Agent 前后要说清的事（纯函数，不碰 Tauri / store，node --test 直接测）。
 * 平台一律显式传 isWindows，不在模块内读。
 */

/** winget 装时会顺带装微软 VC++ 运行库的 agent。运行库只有全机安装版本，没装过的电脑会弹管理员确认。
 *  来源：winget-pkgs 清单的 Dependencies（2026-10-31 核对 OpenAI.Codex 0.161.0、xAI.GrokBuild 1.0.70）。
 *  与 agent_specs.rs 的 winget 包同步：包的依赖变了这里跟着改 */
const WINGET_NEEDS_ADMIN = new Set(["codex", "grok"]);

export interface InstallNoteFacts {
  isWindows: boolean;
  /** 设置 → 网络里填了出网代理 */
  proxyConfigured: boolean;
  /** 依赖体检确认这台电脑没有 Git（未体检时传 false，不瞎报） */
  gitMissing: boolean;
}

/** install_method_preview 返回的预览形如 "winget: winget install --id …" */
export function isWingetMethod(method: string): boolean {
  return method === "winget" || method.startsWith("winget:");
}

/** 安装确认时附在命令下面的提醒，一条一句；没有要提醒的返回空数组 */
export function installNotes(agentId: string, method: string, facts: InstallNoteFacts): string[] {
  const notes: string[] = [];
  if (facts.isWindows && isWingetMethod(method)) {
    if (WINGET_NEEDS_ADMIN.has(agentId)) {
      notes.push(
        "会顺带安装微软 VC++ 运行库：这台电脑没装过时，Windows 会弹一次管理员确认，点「是」。点「否」或当前账户没有管理员权限，安装会失败，要先请电脑管理员装好微软 VC++ 运行库。",
      );
    }
    if (facts.proxyConfigured) {
      notes.push(
        "winget 不走 Mesa 设置里的出网代理，只认 Windows 系统代理：下载连不上时，在代理软件里打开「系统代理」再重试。",
      );
    }
  }
  if (facts.isWindows && agentId === "claude-code" && facts.gitMissing) {
    notes.push(
      "这台电脑还没有 Git for Windows：Claude Code 能启动，但跑不了命令（它的 Bash 工具要用 Git Bash）。可以在「设置 → 诊断 → 依赖体检」一键安装 Git。",
    );
  }
  return notes;
}

/** winget 安装失败的下一步建议；不是 winget 或认不出原因返回 null。
 *  匹配 winget 自己的中英文提示（winget.resw：APPINSTALLER_CLI_ERROR_DOWNLOAD_FAILED 等）与 WinINet 错误码 0x80072xxx */
export function wingetFailureHint(output: string, method: string): string | null {
  if (!isWingetMethod(method)) return null;
  if (
    output.includes("未能安装程序包依赖项") ||
    output.includes("Failed to install package dependencies") ||
    output.includes("你已取消安装") ||
    output.includes("You cancelled the installation")
  ) {
    return "依赖（VC++ 运行库等）没装上：多半是管理员确认点了「否」，或当前账户没有管理员权限。重试时在弹窗里点「是」；当前账户没有管理员权限的，请电脑管理员先装好微软 VC++ 运行库（Visual C++ 2015-2022 x64）再重试。";
  }
  if (
    output.includes("下载安装程序失败") ||
    output.includes("Downloading installer failed") ||
    output.includes("未能下载程序包依赖项") ||
    output.includes("Failed to download package dependencies") ||
    /0x80072[0-9a-f]{3}/i.test(output)
  ) {
    return "winget 下载失败：winget 不走 Mesa 设置里的出网代理，只认 Windows 系统代理。在代理软件里打开「系统代理」后重试。";
  }
  return null;
}
