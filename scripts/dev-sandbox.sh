#!/usr/bin/env bash
# 新用户沙盒实例（macOS / Linux）：用一个空的家目录跑 Mesa Dev，体验或测试「第一次打开」。
#
# 隔离什么：Mesa 自己的数据（连接、网关、密钥、设置、项目登记）、各 CLI 的会话与配置目录、
# 新建项目的默认位置、网页存储（独立 bundle id，上手引导状态等 localStorage 不和主实例共用）。
# 不隔离什么：已经装在系统里的 Agent（PATH 照旧，所以「装一个 Agent」多半直接打勾）；
# 在沙盒里点「安装」装的是系统级 CLI；用 API Key 发的请求照常计费。
#
# 用法：
#   scripts/dev-sandbox.sh           启动（沙盒保留，下次接着用）
#   scripts/dev-sandbox.sh --reset   清空沙盒后启动（重新当一次新用户）
# 清理：rm -rf ~/.ccode-sandbox（含独立的 Rust 构建目录，首次构建要几分钟）
set -euo pipefail

REAL_HOME="$HOME"
ROOT="$REAL_HOME/.ccode-sandbox"
SANDBOX_HOME="$ROOT/home"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--reset" ]]; then
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

export HOME="$SANDBOX_HOME"
# CoreFoundation / WebKit 认这个变量取家目录
export CFFIXED_USER_HOME="$SANDBOX_HOME"
# 工具链与缓存仍用真实家目录里的（换了 HOME 后它们默认会去沙盒里找）
export CARGO_HOME="$REAL_HOME/.cargo"
export RUSTUP_HOME="$REAL_HOME/.rustup"
export npm_config_cache="$REAL_HOME/.npm"
export PATH="$REAL_HOME/.cargo/bin:$PATH"
# 独立构建目录：嵌入的配置不同，和主实例共用 target 会来回重编、抢构建锁
export CARGO_TARGET_DIR="$ROOT/target"

echo "沙盒家目录：$HOME"
echo "窗口标题：Mesa Dev - 新用户沙盒 :17577（首次构建要几分钟）"
cd "$REPO"
exec npx tauri dev --config src-tauri/tauri.dev.17577.conf.json
