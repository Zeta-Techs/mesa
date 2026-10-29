#!/usr/bin/env bash
# 打包版自动点验（Windows，Git Bash）：清空新用户沙盒 → 把打好的程序按安装后的布局摆好 → 生成样例项目 →
# 在沙盒里起程序并开 WebView2 远程调试 → smoke.mjs 逐步点验 → 关掉这个程序。
# 不动已安装的 Mesa、不动真实数据：Mesa 数据、各 CLI 配置、WebView2 存储都在 ~/.ccode-sandbox/home 里。
#
# 用法（先在仓库根打包：npx tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'，没有更新签名私钥时要这样关掉更新包）：
#   scripts/win-package-smoke/run.sh [结果目录，默认 ~/.ccode-sandbox/smoke-out] [调试端口，默认 9333]
# 结果：结果目录下 report.json 与逐步截图；有失败退出码 1。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$HOME/.ccode-sandbox/smoke-out}"
PORT="${2:-9333}"
REL="$REPO/src-tauri/target/release"
APP="$HOME/.ccode-sandbox/app"
PY="${PYTHON:-/c/Program Files/Python313/python.exe}"

[[ -f "$REL/ccode.exe" ]] || { echo "没有 $REL/ccode.exe：先打包" >&2; exit 2; }
if netstat -ano | grep -q ":$PORT .*LISTENING"; then
  echo "调试端口 $PORT 被占用（上一次的点验程序还开着？），换一个端口或先关掉" >&2
  exit 2
fi

# 安装包装出来的就是这几样：主程序、随包 helper、浏览器扩展、第三方声明（见 tauri.conf.json bundle）
rm -rf "$APP"
mkdir -p "$APP/resources"
cp "$REL/ccode.exe" "$REL/mesa_helper.exe" "$APP/"
cp -r "$REPO/src-tauri/extension-src" "$APP/"
cp "$REL/resources/third-party-notices.md" "$APP/resources/"

rm -rf "$HOME/.ccode-sandbox/home" "$OUT"
mkdir -p "$HOME/.ccode-sandbox/home/Documents"
PROJECT="$(cygpath -w "$HOME/.ccode-sandbox/home/Documents")\\点验项目"
"$PY" -I -X utf8 "$REPO/scripts/win-package-smoke/make_samples.py" "$PROJECT"

bash "$REPO/scripts/dev-sandbox.sh" --app "$APP/ccode.exe" --debug-port "$PORT" > "$HOME/.ccode-sandbox/app.log" 2>&1 &
cleanup() {
  # 只关沙盒里这一份（按程序路径认），已安装的 Mesa 不动
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='ccode.exe'\" | ? { \$_.ExecutablePath -like '*\\.ccode-sandbox\\app\\*' } | % { Stop-Process -Id \$_.ProcessId -Force }" || true
}
trap cleanup EXIT
set +e
node "$REPO/scripts/win-package-smoke/smoke.mjs" --port "$PORT" --project "$PROJECT" --out "$(cygpath -w "$OUT")"
status=$?
exit $status
