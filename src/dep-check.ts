/**
 * 依赖体检（git / node）前端纯逻辑：DTO 镜像 dep_check.rs，判定与 DOM/Tauri 解耦，
 * 供 node --test 直接测。平台相关判定一律显式传参（platform），禁模块内读平台。
 */

/** 与 dep_check.rs DepItemDto 对应（camelCase 序列化） */
export interface DepItemDto {
  /** ok | missing | clt_stub | broken（clt_stub 仅 macOS git：Xcode CLT 未装的系统占位；
   *  broken 仅 quarto：找到了但跑不起来，`--version` 没有版本输出） */
  status: "ok" | "missing" | "clt_stub" | "broken";
  version: string | null;
  path: string | null;
  /** 未就绪的具体原因（如 quarto 被残留环境变量带坏），有就直接显示 */
  note?: string | null;
}

/** 与 dep_check.rs DepCheckDto 对应 */
export interface DepCheckDto {
  git: DepItemDto;
  node: DepItemDto;
  /** 渲 PDF/Word。缺失只展示，诊断页不代装。 */
  quarto: DepItemDto;
  /** xelatex / tectonic / pdflatex 任一在即可。 */
  tex: DepItemDto;
  /** 综述拼图裁切。 */
  pymupdf: DepItemDto;
  /** 综述拼图排版。 */
  pillow: DepItemDto;
  /** 一键安装渠道：brew | winget | xcode | none */
  channel: "brew" | "winget" | "xcode" | "none";
  checkedAt: string;
}

/** 与 updater.rs UpdateResultDto 对应 */
export interface UpdateResultDto {
  ok: boolean;
  output: string;
  method: string;
  versionBefore: string | null;
  versionAfter: string | null;
}

export type DepTool = "git" | "node" | "quarto" | "tex" | "pymupdf" | "pillow";
export type DepPlatform = "mac" | "win" | "linux";

/** git 缺失错误识别：后端错误串单一出处在 git_info.rs/workspaces.rs/projects.rs
 *  （「找不到 git 可执行文件，请先安装 git」），这里只认该子串，不改后端 */
export function isGitMissingError(msg: string): boolean {
  return msg.includes("找不到 git 可执行文件");
}

const SITES: Record<DepTool, string> = {
  git: "git-scm.com",
  node: "nodejs.org",
  quarto: "quarto.org",
  tex: "tectonic-typesetting.github.io",
  pymupdf: "pypi.org/project/pymupdf",
  pillow: "pypi.org/project/pillow",
};

const APT: Record<DepTool, string> = {
  git: "git",
  node: "nodejs",
  quarto: "",
  tex: "tectonic",
  pymupdf: "python3-pymupdf",
  pillow: "python3-pil",
};

/** 一键安装可行性。拼图库走本机 pip，不看 brew/winget。
 *  git 在 Mac 无 brew 时仍可弹系统安装窗口。其余项要有 brew 或 winget。 */
/** 未就绪时的一句原因（设置页依赖行） */
export function depMissingReason(item: Pick<DepItemDto, "status" | "path" | "note">): string {
  if (item.note?.trim()) return item.note.trim();
  if (item.status === "clt_stub") return "需要安装 Xcode 命令行工具";
  if (item.status === "broken")
    return `找到的 ${item.path ?? "程序"} 跑不起来；装好官方版后让它排在这个之前，或删掉这个`;
  return "未安装";
}

export function canOneClickInstall(tool: DepTool, channel: string): boolean {
  if (tool === "pymupdf" || tool === "pillow") return true;
  if (tool === "git")
    return channel === "brew" || channel === "winget" || channel === "xcode";
  return channel === "brew" || channel === "winget";
}

/** 不可一键装时的指引文案（口径与 dep_check.rs 的无渠道报错文案一致）；
 *  channel 参与签名留给调用方传原始值，实际分支只看 platform */
export function installGuidance(
  tool: DepTool,
  _channel: string,
  platform: DepPlatform,
): string {
  if (platform === "mac") {
    if (tool === "git") {
      return "未检测到 Homebrew：点「安装」触发系统安装窗口（Xcode 命令行工具），装完点「重新检测」";
    }
    return `未检测到 Homebrew：请到 ${SITES[tool]} 下载安装包，或先安装 Homebrew，装完点「重新检测」`;
  }
  if (platform === "win") {
    return `未检测到 winget：请到 ${SITES[tool]} 下载安装包，装完点「重新检测」`;
  }
  const pkg = APT[tool];
  if (!pkg) return `请到 ${SITES[tool]} 下载安装包，装完点「重新检测」`;
  return `请用发行版包管理器安装（如 sudo apt install ${pkg}），装完点「重新检测」`;
}

/** 缺 git 的常驻收件箱条目：git 缺失 = 工作区/评审全不可用，值得常驻提醒；
 *  node 缺失不进收件箱（它只是 npm 渠道依赖，只在装 CLI 时提示） */
export function depInboxItem(
  dep: DepCheckDto | null,
): { key: string; text: string } | null {
  if (!dep) return null;
  if (dep.git.status === "missing")
    return { key: "dep:git", text: "缺少 Git：工作区与评审功能不可用" };
  if (dep.git.status === "clt_stub")
    return { key: "dep:git", text: "需要安装 Xcode 命令行工具才能使用 Git" };
  return null;
}
