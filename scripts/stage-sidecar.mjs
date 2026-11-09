// 打包前置：把 mesa_helper 编成 release 并按 Tauri sidecar 约定改名落位。
// bundle.externalBin 需要 src-tauri/binaries/mesa_helper-<triple>[.exe]——
// 同 crate 的 cargo 多 bin 不会自动进 bundle（2026-09-17 实测：打包版装了浏览器桥
// 却报「找不到 helper」，开发模式能跑纯粹因为 target/debug 里恰好有它）。
// 挂在 beforeBuildCommand 里（npm run build && node scripts/stage-sidecar.mjs），
// 只影响打包，不改 dev 流程（dev 用 target/debug/mesa_helper，README 有说明）。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const tauriDir = join(root, "src-tauri");

// host triple：aarch64-apple-darwin / x86_64-pc-windows-msvc …（打包机本机）
const v = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = /^host:\s*(\S+)/m.exec(v)?.[1];
if (!host) throw new Error("[stage-sidecar] 无法从 rustc -vV 解析 host triple");

// 目标 triple 优先读 Tauri 注入的环境变量（`tauri build --target <triple>` 交叉
// 打包时，产物在 target/<triple>/release 而不是 target/release——旧脚本只认
// host 与 target/release，交叉打包会 staged 错名字/错目录，2026-09-17 审计）
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET || host;
const cross = target !== host;
console.log(`[stage-sidecar] host triple: ${host}${cross ? `（交叉打包 → ${target}）` : ""}`);

const ext = process.platform === "win32" ? ".exe" : "";

// universal-apple-darwin 是 Tauri 的合成 triple：cargo 不认识，CLI 会拆成
// aarch64/x86_64 各构建再 lipo——这里同款处理（终检二轮：直接 cargo build
// --target universal-* 会硬挂）
const universal = target === "universal-apple-darwin";
if (universal) {
  for (const arch of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    execFileSync(
      "cargo",
      ["build", "--release", "--bin", "mesa_helper", "--target", arch],
      { cwd: tauriDir, stdio: "inherit" },
    );
  }
  const outDirU = join(tauriDir, "target", target, "release");
  mkdirSync(outDirU, { recursive: true });
  execFileSync(
    "lipo",
    [
      "-create",
      "-output",
      join(outDirU, `mesa_helper${ext}`),
      join(tauriDir, "target", "aarch64-apple-darwin", "release", `mesa_helper${ext}`),
      join(tauriDir, "target", "x86_64-apple-darwin", "release", `mesa_helper${ext}`),
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--bin",
      "mesa_helper",
      ...(cross ? ["--target", target] : []),
    ],
    { cwd: tauriDir, stdio: "inherit" },
  );
}

const releaseDir = cross
  ? join(tauriDir, "target", target, "release")
  : join(tauriDir, "target", "release");
const src = join(releaseDir, `mesa_helper${ext}`);
const outDir = join(tauriDir, "binaries");
mkdirSync(outDir, { recursive: true });
const dst = join(outDir, `mesa_helper-${target}${ext}`);
copyFileSync(src, dst);
chmodSync(dst, 0o755); // copyFile 虽随源模式，显式钉一遍防 umask 环境差异
console.log(`[stage-sidecar] ${dst}`);
