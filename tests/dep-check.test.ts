import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canOneClickInstall,
  depInboxItem,
  depMissingReason,
  installGuidance,
  isGitMissingError,
  type DepCheckDto,
} from "../src/dep-check.ts";

const absent = { status: "missing" as const, version: null, path: null };

function dep(partial: Partial<DepCheckDto["git"]>, nodeOk = true): DepCheckDto {
  return {
    git: { status: "ok", version: "2.51.0", path: "/usr/bin/git", ...partial },
    node: nodeOk
      ? { status: "ok", version: "22.0.0", path: "/usr/local/bin/node" }
      : { status: "missing", version: null, path: null },
    quarto: absent,
    tex: absent,
    pymupdf: absent,
    pillow: absent,
    channel: "brew",
    checkedAt: "2026-09-02 10:00:00",
  };
}

test("isGitMissingError：命中后端固定错误串，误伤不识别", () => {
  assert.ok(isGitMissingError("找不到 git 可执行文件，请先安装 git"));
  assert.ok(isGitMissingError("Error: 找不到 git 可执行文件，请先安装 git"));
  assert.ok(!isGitMissingError("找不到 node 可执行文件"));
  assert.ok(!isGitMissingError("git: command not found"));
  assert.ok(!isGitMissingError(""));
});

test("canOneClickInstall：git 三渠道可，node/quarto/tex 仅 brew/winget，拼图库始终可", () => {
  for (const ch of ["brew", "winget", "xcode"])
    assert.ok(canOneClickInstall("git", ch), `git/${ch}`);
  assert.ok(!canOneClickInstall("git", "none"));
  assert.ok(!canOneClickInstall("git", "unknown"));
  for (const tool of ["node", "quarto", "tex"] as const) {
    for (const ch of ["brew", "winget"])
      assert.ok(canOneClickInstall(tool, ch), `${tool}/${ch}`);
    assert.ok(!canOneClickInstall(tool, "xcode"));
    assert.ok(!canOneClickInstall(tool, "none"));
  }
  assert.ok(canOneClickInstall("pymupdf", "none"));
  assert.ok(canOneClickInstall("pillow", "xcode"));
});

test("installGuidance：mac 无 brew 时 node 指 nodejs.org、git 指系统弹窗", () => {
  const nodeMac = installGuidance("node", "xcode", "mac");
  assert.ok(nodeMac.includes("nodejs.org"));
  assert.ok(nodeMac.includes("Homebrew"));
  assert.ok(!nodeMac.includes("git-scm.com"));
  const gitMac = installGuidance("git", "xcode", "mac");
  assert.ok(gitMac.includes("系统安装窗口"));
  assert.ok(!gitMac.includes("nodejs.org"));
});

test("installGuidance：win 无 winget 按工具指官网", () => {
  const gitWin = installGuidance("git", "none", "win");
  assert.ok(gitWin.includes("git-scm.com"));
  assert.ok(gitWin.includes("winget"));
  assert.ok(!gitWin.includes("nodejs.org"));
  const nodeWin = installGuidance("node", "none", "win");
  assert.ok(nodeWin.includes("nodejs.org"));
  assert.ok(!nodeWin.includes("git-scm.com"));
});

test("installGuidance：linux 指包管理器，git/node 包名分开", () => {
  const gitLinux = installGuidance("git", "none", "linux");
  assert.ok(gitLinux.includes("apt install git"));
  assert.ok(!gitLinux.includes("nodejs"));
  assert.ok(installGuidance("node", "none", "linux").includes("apt install nodejs"));
  assert.ok(installGuidance("tex", "none", "linux").includes("apt install tectonic"));
  assert.ok(installGuidance("quarto", "none", "linux").includes("quarto.org"));
  assert.ok(installGuidance("pymupdf", "none", "linux").includes("python3-pymupdf"));
});

test("depInboxItem：git missing → 常驻条目；clt_stub → CLT 文案", () => {
  const missing = depInboxItem(dep({ status: "missing", version: null, path: null }));
  assert.deepEqual(missing, {
    key: "dep:git",
    text: "缺少 Git：工作区与评审功能不可用",
  });
  const stub = depInboxItem(dep({ status: "clt_stub", version: null }));
  assert.equal(stub?.key, "dep:git");
  assert.ok(stub?.text.includes("Xcode 命令行工具"));
});

test("depInboxItem：git ok / 整体 null / 仅 node 缺失 → 无条目", () => {
  assert.equal(depInboxItem(dep({})), null);
  assert.equal(depInboxItem(null), null);
  // node 缺失不进收件箱（只在装 CLI 时提示）
  assert.equal(depInboxItem(dep({}, false)), null);
});

test("跑不起来的 quarto 点名路径，不报成「未安装」", () => {
  assert.equal(depMissingReason({ status: "missing", path: null }), "未安装");
  assert.match(
    depMissingReason({ status: "broken", path: "/opt/conda/bin/quarto" }),
    /\/opt\/conda\/bin\/quarto 跑不起来/,
  );
  assert.equal(depMissingReason({ status: "clt_stub", path: "/usr/bin/git" }), "需要安装 Xcode 命令行工具");
  // 后端给了具体原因（残留环境变量）就照它说，不让人去重装
  assert.equal(
    depMissingReason({ status: "broken", path: "/x/quarto", note: "环境变量 QUARTO_SHARE_PATH 指向已删除的路径" }),
    "环境变量 QUARTO_SHARE_PATH 指向已删除的路径",
  );
});
