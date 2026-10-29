#!/usr/bin/env bash
# 打包版新用户沙盒（macOS）：拿一个装好的 Mesa.app，用一个空的家目录另起一个实例，验「安装版第一次打开」。
# 开发版的新用户沙盒见 scripts/dev-sandbox.sh；这里测的是打包产物本身（压缩过的前端、生产 CSP、
# 随包 helper、从访达启动的短环境），开发版复现不了的问题只能在这里看到。
#
# 隔离什么：Mesa 自己的数据、各 CLI 的会话与配置目录、新建项目与示例课题的位置、网页存储（localStorage）——
# HOME 与 CFFIXED_USER_HOME 都指到沙盒家目录。经 `open -n` 由系统启动，和从访达双击一样拿不到终端里的环境变量。
# 不隔离什么：系统里已装的 Agent；存在钥匙串里的登录（Claude Code 的官方账号登录在钥匙串，沙盒里也看得见）；
# 用 API Key 发的请求照常计费。和正在用的 Mesa 同时开着互不影响（不同家目录、不占固定端口）。
#
# 用法：
#   scripts/app-sandbox.sh [--app <Mesa.app 路径>] [--home <沙盒家目录>] [--reset]
#     --app    默认 /Applications/Mesa.app
#     --home   默认 ~/.ccode-app-sandbox/home；想同时留几套就各给一个目录
#     --reset  清空沙盒家目录后启动（重新当一次新用户）
# 输出最后一行是新实例的进程号，scripts/app-smoke/smoke.sh 用它点验；结束用 kill <进程号>。
set -euo pipefail

APP="/Applications/Mesa.app"
SANDBOX_HOME="$HOME/.ccode-app-sandbox/home"
RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --home) SANDBOX_HOME="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ "$(uname)" == "Darwin" ]] || { echo "只支持 macOS（Windows / Linux 换家目录的方式不同）" >&2; exit 2; }
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
EXE_NAME="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP/Contents/Info.plist")"
EXE="$APP/Contents/MacOS/$EXE_NAME"
[[ -x "$EXE" ]] || { echo "找不到可执行文件：$EXE" >&2; exit 2; }
case "$SANDBOX_HOME" in
  "$HOME" | "$HOME/" | / | "") echo "沙盒家目录不能是真实家目录或根目录：$SANDBOX_HOME" >&2; exit 2 ;;
esac

# 同一个沙盒家目录只能有一个实例（两个进程抢同一份配置，等于自己制造并发写）
PIDFILE="$SANDBOX_HOME/.app-sandbox.pid"
if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE")"
  if ps -p "$old" -o command= 2>/dev/null | grep -qF "$EXE"; then
    echo "这个沙盒已有实例在跑（进程 $old），先 kill $old" >&2
    exit 1
  fi
fi

if [[ $RESET == 1 ]]; then
  rm -rf "$SANDBOX_HOME"
  echo "已清空沙盒家目录：$SANDBOX_HOME" >&2
fi
mkdir -p "$SANDBOX_HOME/Downloads" "$SANDBOX_HOME/Documents" "$SANDBOX_HOME/Desktop"
SANDBOX_HOME="$(cd "$SANDBOX_HOME" && pwd -P)"
# git 身份照抄（否则建示例课题时提交报 Author identity unknown，那是另一类问题）
if [[ -f "$HOME/.gitconfig" && ! -f "$SANDBOX_HOME/.gitconfig" ]]; then
  cp "$HOME/.gitconfig" "$SANDBOX_HOME/.gitconfig"
fi
# 空家目录下 zsh 会弹 zsh-newuser-install 向导，放一个空 .zshrc 挡掉
[[ -f "$SANDBOX_HOME/.zshrc" ]] || echo "# Mesa 新用户沙盒" > "$SANDBOX_HOME/.zshrc"

before="$(pgrep -f "$EXE" | sort || true)"
# open 会把调用方的环境变量整份带给新进程（2026-10-29 实测：终端里的 PATH 原样出现在沙盒进程里），
# 先用 env -i 清成从访达双击时 launchd 给的那几项，才是新用户真实拿到的环境
env -i USER="$USER" LOGNAME="${LOGNAME:-$USER}" HOME="$HOME" SHELL="${SHELL:-/bin/zsh}" TMPDIR="${TMPDIR:-/tmp/}" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/open -n -g -a "$APP" \
  --env "HOME=$SANDBOX_HOME" \
  --env "CFFIXED_USER_HOME=$SANDBOX_HOME" \
  --stdout "$SANDBOX_HOME/mesa-stdout.log" \
  --stderr "$SANDBOX_HOME/mesa-stderr.log"

pid=""
for _ in $(seq 1 100); do
  now="$(pgrep -f "$EXE" | sort || true)"
  pid="$(comm -13 <(echo "$before") <(echo "$now") | head -1)"
  [[ -n "$pid" ]] && break
  sleep 0.1
done
[[ -n "$pid" ]] || { echo "实例没起来，看 $SANDBOX_HOME/mesa-stderr.log" >&2; exit 1; }
echo "$pid" > "$SANDBOX_HOME/.app-sandbox.pid"
echo "沙盒家目录：$SANDBOX_HOME" >&2
echo "应用：$APP（$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")）" >&2
echo "$pid"
