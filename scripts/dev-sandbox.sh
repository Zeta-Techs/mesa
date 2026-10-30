#!/usr/bin/env bash
# 新用户沙盒实例（macOS / Linux / Windows 的 Git Bash）：用一个空的家目录跑 Mesa，体验或测试「第一次打开」。
#
# 隔离什么：Mesa 自己的数据（连接、网关、密钥、设置、项目登记）、各 CLI 的会话与配置目录、
# 新建项目的默认位置、网页存储（独立 bundle id / 独立 WebView2 数据目录，上手引导状态等 localStorage 不和主实例共用）。
# 不隔离什么：已经装在系统里的 Agent（PATH 照旧，所以「装一个 Agent」多半直接打勾）；
# 用 API Key 发的请求照常计费。
#
# Windows 上光改 HOME 不够：Mesa 找目录走系统已知文件夹，不看环境变量。这里另设 MESA_SANDBOX_HOME
# （src-tauri/src/dirs.rs：Mesa 的家目录、AppData、文稿、下载、桌面都换到它下面），再把 USERPROFILE / APPDATA /
# LOCALAPPDATA 指进来，给各家 CLI 和它们起的程序用（npm 全局目录随 APPDATA 进沙盒，沙盒里装的 CLI 不进真实目录）。
#
# 用法：
#   scripts/dev-sandbox.sh                         启动开发版（窗口「Mesa Dev - 新用户沙盒 :17577」，沙盒保留，下次接着用）
#   scripts/dev-sandbox.sh --reset                 清空沙盒后启动（重新当一次新用户）
#   scripts/dev-sandbox.sh --app <程序> [--debug-port 9333]
#                                                  不起开发版，直接在沙盒里跑打好的程序（如 target/release/ccode.exe），
#                                                  点验打包版用；Windows 上 --debug-port 打开 WebView2 远程调试
#                                                  （scripts/win-package-smoke/ 的自动点验靠它）
# 清理：rm -rf ~/.ccode-sandbox（含独立的 Rust 构建目录，首次构建要几分钟）
set -euo pipefail

REAL_HOME="$HOME"
ROOT="$REAL_HOME/.ccode-sandbox"
SANDBOX_HOME="$ROOT/home"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP=""
DEBUG_PORT=""
RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=1 ;;
    --app) APP="$2"; shift ;;
    --debug-port) DEBUG_PORT="$2"; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) WINDOWS=1 ;; *) WINDOWS=0 ;; esac

if [[ $RESET == 1 ]]; then
  rm -rf "$SANDBOX_HOME"
  echo "已清空沙盒家目录：$SANDBOX_HOME"
fi

mkdir -p "$SANDBOX_HOME" "$ROOT/target"
# 像一个真实的家目录：下载夹（文献收货监听）、文稿（新建项目默认位置）、桌面
mkdir -p "$SANDBOX_HOME/Downloads" "$SANDBOX_HOME/Documents" "$SANDBOX_HOME/Desktop"
# git 身份照抄（否则建项目时提交会报 Author identity unknown，那是另一类问题）
if [[ -f "$REAL_HOME/.gitconfig" && ! -f "$SANDBOX_HOME/.gitconfig" ]]; then
  cp "$REAL_HOME/.gitconfig" "$SANDBOX_HOME/.gitconfig"
fi
# 空家目录下 zsh 会弹 zsh-newuser-install 向导，放一个空 .zshrc 挡掉
[[ -f "$SANDBOX_HOME/.zshrc" ]] || echo "# Mesa 新用户沙盒" > "$SANDBOX_HOME/.zshrc"

# 工具链与缓存仍用真实家目录里的（换了家目录后它们默认会去沙盒里找）
export CARGO_HOME="${CARGO_HOME:-$REAL_HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$REAL_HOME/.rustup}"
export npm_config_cache="$REAL_HOME/.npm"
export PATH="$REAL_HOME/.cargo/bin:$PATH"
export HOME="$SANDBOX_HOME"
if [[ $WINDOWS == 1 ]]; then
  mkdir -p "$SANDBOX_HOME/AppData/Roaming" "$SANDBOX_HOME/AppData/Local"
  WIN_HOME="$(cygpath -w "$SANDBOX_HOME")"
  export MESA_SANDBOX_HOME="$WIN_HOME"
  export USERPROFILE="$WIN_HOME"
  export APPDATA="$WIN_HOME\\AppData\\Roaming"
  export LOCALAPPDATA="$WIN_HOME\\AppData\\Local"
else
  # CoreFoundation / WebKit 认这个变量取家目录
  export CFFIXED_USER_HOME="$SANDBOX_HOME"
fi

echo "沙盒家目录：$SANDBOX_HOME"
if [[ -n "$APP" ]]; then
  if [[ $WINDOWS == 1 ]]; then
    # 打包版的 WebView2 数据目录按 bundle id 放在真实 LOCALAPPDATA 下，与已装的 Mesa 同一处：用环境变量挪进沙盒
    export WEBVIEW2_USER_DATA_FOLDER="$LOCALAPPDATA\\Mesa-Sandbox-WebView2"
    [[ -n "$DEBUG_PORT" ]] && export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$DEBUG_PORT"
  fi
  echo "在沙盒里运行：$APP"
  exec "$APP"
fi
# 独立构建目录：嵌入的配置不同，和主实例共用 target 会来回重编、抢构建锁
export CARGO_TARGET_DIR="$ROOT/target"
echo "窗口标题：Mesa Dev - 新用户沙盒 :17577（首次构建要几分钟）"
cd "$REPO"
exec npx tauri dev --config src-tauri/tauri.dev.17577.conf.json
