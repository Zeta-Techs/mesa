// 从 src-tauri/icons/source/ 的设计源重新生成全套应用图标（仅 macOS 可跑）。
// 设计源：
//   mesa-dark.svg          通用图标（macOS 旧系统 icns / Linux png / iOS / Android），墨底版
//   mesa-dark-windows.svg  同一设计、瓷砖撑满画布，只出 Windows 的 ico 与 Store 方图
//   mesa-light.svg         浅色版平面稿（打包图标的浅色由 Mesa.icon 的外观特化给出；
//                          这里只出运行时换图与设置页预览）
//   mesa-light-windows.svg 浅色撑满版，运行时 Windows/Linux 主窗与托盘
//   Mesa.icon              Icon Composer 文档：macOS 26+ 按系统外观切深/浅/透明/染色
// Mesa.icon 预编译成 icons/Assets.car 提交进仓，打包时 tauri 直接拷贝——不在打包时跑
// actool：一来 CI 不必装 Xcode 26，二来 tauri 2.11 起子进程时 stdin 是关着的，
// actool 读 .icon 会报 Bad file descriptor（2026-10-17 实证）。
// 依赖：rsvg-convert（brew install librsvg）、Xcode 26+ 的 actool。
// 改了任何设计源后跑 `npm run gen:icons`，生成物连同源文件一起提交。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const icons = join(root, "src-tauri/icons");
const source = join(icons, "source");
const tmp = mkdtempSync(join(tmpdir(), "mesa-icons-"));

// stdin 给 /dev/null 而不是关掉：actool 在 fd 0 缺失时会失败
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

function render(name) {
  const out = join(tmp, `${name}.png`);
  run("rsvg-convert", ["-w", "1024", "-h", "1024", join(source, `${name}.svg`), "-o", out]);
  return out;
}

try {
  run("npx", ["tauri", "icon", render("mesa-dark")]);

  const winOut = join(tmp, "windows");
  run("npx", ["tauri", "icon", render("mesa-dark-windows"), "-o", winOut]);
  for (const f of readdirSync(winOut)) {
    if (f === "icon.ico" || f === "StoreLogo.png" || /^Square\d+x\d+Logo\.png$/.test(f)) {
      copyFileSync(join(winOut, f), join(icons, f));
    }
  }

  const carOut = join(tmp, "car");
  mkdirSync(carOut);
  // actool 要求输入目录名与 --app-icon 一致
  cpSync(join(source, "Mesa.icon"), join(tmp, "Icon.icon"), { recursive: true });
  run("actool", [
    join(tmp, "Icon.icon"),
    "--compile", carOut,
    "--output-format", "human-readable-text",
    "--errors",
    "--output-partial-info-plist", join(carOut, "partial.plist"),
    "--app-icon", "Icon",
    "--include-all-app-icons",
    "--enable-on-demand-resources", "NO",
    "--development-region", "en",
    "--target-device", "mac",
    "--minimum-deployment-target", "26.0",
    "--platform", "macosx",
  ]);
  copyFileSync(join(carOut, "Assets.car"), join(icons, "Assets.car"));

  // 运行时换图（设置 → 外观 → 应用图标）：macOS 程序坞用 Apple 网格版 512，
  // Windows/Linux 主窗与托盘用撑满版 256（include_image! 存原始像素，尺寸要小）；
  // 设置页两张预览图 128 进前端 assets
  const runtime = join(icons, "runtime");
  const previews = join(root, "src/assets/app-icon");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(previews, { recursive: true });
  for (const tone of ["dark", "light"]) {
    const svg = (name) => join(source, `${name}.svg`);
    run("rsvg-convert", ["-w", "512", "-h", "512", svg(`mesa-${tone}`), "-o", join(runtime, `dock-${tone}.png`)]);
    run("rsvg-convert", ["-w", "256", "-h", "256", svg(`mesa-${tone}-windows`), "-o", join(runtime, `window-${tone}.png`)]);
    run("rsvg-convert", ["-w", "128", "-h", "128", svg(`mesa-${tone}`), "-o", join(previews, `${tone}.png`)]);
  }
  // macOS 菜单栏托盘模板图：系统把它缩到 18pt 高，出 3 倍像素即可，宽度随源比例
  run("rsvg-convert", ["-h", "54", join(source, "mesa-tray-template.svg"), "-o", join(runtime, "tray-template.png")]);
  console.log("图标已重新生成：src-tauri/icons/（含 Assets.car 与 runtime/）+ src/assets/app-icon/");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
