#!/usr/bin/env bash
# 打包版自动点验（macOS）：在新用户沙盒里起一个装好的 Mesa.app，按「第一次打开」的路径把主要页面点一遍，
# 每一步查有没有整页「界面渲染出错」，截图并写报告。驱动走无障碍接口（ax.swift），按控件文字按下，
# 不移动鼠标、不发键盘事件，不会点进别的应用；只在开头把沙盒窗口提到最前一次（网页内容的无障碍树要窗口激活过才建）。
#
# 用法：
#   scripts/app-smoke/smoke.sh [--app <Mesa.app>] [--home <沙盒家目录>] [--out <报告目录>] [--keep]
#     --app   默认 /Applications/Mesa.app；验刚打的包用 src-tauri/target/release/bundle/macos/Mesa.app
#     --home  默认 ~/.ccode-app-sandbox/smoke-home，每次清空重来
#     --out   默认 <沙盒家目录>/../smoke-report
#     --keep  跑完不退出沙盒实例，留着手动看
# 退出码：0 全部通过；1 有步骤失败（看报告）；2 环境问题（没权限、起不来）
# 前提：运行它的终端 / 应用在「系统设置 → 隐私与安全性 → 辅助功能」里已打开（截图另需「录屏与系统录音」，
# 没有时只缺截图、不影响判定）。屏幕锁着时拿不到窗口内容，先解锁。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP="/Applications/Mesa.app"
SANDBOX_HOME="$HOME/.ccode-app-sandbox/smoke-home"
OUT=""
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --home) SANDBOX_HOME="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" ]] || OUT="$(dirname "$SANDBOX_HOME")/smoke-report"
rm -rf "$OUT"
mkdir -p "$OUT/shots"

# 编译无障碍驱动（源文件没变就复用）
AXBIN="${TMPDIR:-/tmp}/mesa-app-smoke/ax"
mkdir -p "$(dirname "$AXBIN")"
if [[ ! -x "$AXBIN" || "$REPO/scripts/app-smoke/ax.swift" -nt "$AXBIN" ]]; then
  swiftc -O "$REPO/scripts/app-smoke/ax.swift" -o "$AXBIN" || { echo "编译 ax.swift 失败（要 Xcode 命令行工具）" >&2; exit 2; }
fi

REPORT="$OUT/report.md"
FAILS=0
STEP=0
log() { echo "$*"; echo "$*" >> "$REPORT"; }
ax() { "$AXBIN" "$@"; }

PID="$("$REPO/scripts/app-sandbox.sh" --app "$APP" --home "$SANDBOX_HOME" --reset 2>"$OUT/launch.log")" || {
  cat "$OUT/launch.log" >&2; exit 2; }
cleanup() { [[ $KEEP == 1 ]] || kill "$PID" 2>/dev/null; }
trap cleanup EXIT
SANDBOX_HOME="$(cd "$SANDBOX_HOME" && pwd -P)"

VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
{
  echo "# 打包版点验报告"
  echo
  echo "- 应用：\`$APP\`（$VERSION，$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$APP")）"
  echo "- 签名：$(codesign -dv "$APP" 2>&1 | grep -E '^Signature=' | cut -d= -f2)"
  echo "- 沙盒家目录：\`$SANDBOX_HOME\`"
  echo "- 时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo
} > "$REPORT"

# 开头激活一次，网页内容的无障碍树才会建出来
sleep 3
ax raise "$PID" >/dev/null 2>&1
if ! ax wait "$PID" "Mesa" 60 2>/dev/null || ! ax wait "$PID" "通知" 60 2>/dev/null; then
  log "- ✗ 启动：60 秒内拿不到窗口内容（屏幕锁着？没给辅助功能权限？）"
  exit 2
fi

# 一步 = 动作 + 查报错页 + 截图。报错页出现记失败，按「尝试恢复」接着往下走
check() {
  local name="$1"
  STEP=$((STEP + 1))
  local shot
  shot="$(printf '%02d' "$STEP")-$(echo "$name" | sed 's#[ /：（）]#_#g').png"
  ax shot "$PID" "$OUT/shots/$shot" >/dev/null 2>&1 || shot=""
  if ax texts "$PID" 2>/dev/null | grep -q "界面渲染出错"; then
    FAILS=$((FAILS + 1))
    local stack
    stack="$(ax texts "$PID" | grep -A1 "界面渲染出错" | tail -1 | cut -c1-300)"
    log "- ✗ $name：整页「界面渲染出错」——\`$stack\`${shot:+（[截图](shots/$shot)）}"
    ax press "$PID" "尝试恢复" >/dev/null 2>&1
    sleep 1
  else
    log "- ✓ $name${shot:+（[截图](shots/$shot)）}"
  fi
}

# 按不下记失败（找不到控件本身就是问题：文案改了或页面没出来）
press() {
  local what="$1"; shift
  if ! ax press "$PID" "$@" >/dev/null 2>"$OUT/last-press.err"; then
    FAILS=$((FAILS + 1))
    log "- ✗ $what：$(cat "$OUT/last-press.err")"
    return 1
  fi
  sleep 1.2
}

log "## 第一次打开"
if ax texts "$PID" | grep -qx "稍后再说"; then
  log "- 上手向导：全屏三步向导"
  # 向导第一屏列出认出的 Agent：从访达启动认不出已装的 CLI，是短 PATH 一类问题
  agents="$(ax texts "$PID" | sed -n '/^已装好，选一个：$/,/^接入方式$/p' | sed '1d;$d' | grep -vx '[01]' | awk '{ printf "%s%s", (NR > 1 ? "、" : ""), $0 }')"
  [[ -n "$agents" ]] && log "- 认出的 Agent：$agents" || log "- 认出的 Agent：（向导第一屏没列，多半一个都没认出）"
  press "关上手向导" "稍后再说" --exact
elif ax texts "$PID" | grep -qx "先自己看看"; then
  log "- 上手向导：欢迎弹窗（旧版）"
  press "关欢迎弹窗" "先自己看看" --exact
fi
check "首屏"

log
log "## 各页"
for page in 连接 对话管理 技能 MCP 用量 设置 工作台; do
  press "进「$page」" "$page" --exact --role AXButton && check "「$page」页"
done

log
log "## 示例课题与文件预览"
# 新版工作台空态有「创建示例课题」按钮直接建；旧版是侧栏 ＋ 菜单里的一项
press "创建示例课题" "创建示例课题" --role AXButton
ax press "$PID" "创建示例课题" --role AXMenuItem >/dev/null 2>&1
if ax wait "$PID" "示例课题（演示）" 60 2>/dev/null; then
  check "建好示例课题"
  PROJ="$SANDBOX_HOME/Documents/Mesa 示例课题"
  FILES="$PROJ/smoke-files"
  mkdir -p "$FILES"
  printf '\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n' > "$FILES/main.tex"
  printf 'import json\nprint(json.dumps({"a": 1}))\n' > "$FILES/analysis.py"
  printf '{"name": "smoke", "n": 3}\n' > "$FILES/data.json"
  printf 'a,b\n1,2\n3,4\n' > "$FILES/table.csv"
  printf '<!doctype html><h1>smoke</h1>\n' > "$FILES/page.html"
  printf 'body { color: #fff; }\n' > "$FILES/style.css"
  printf 'const a = 1;\nfunction f(x) { return x + a; }\n' > "$FILES/app.js"
  printf 'export const n: number = 1;\n' > "$FILES/mod.ts"
  printf '# 标题\n\n正文与公式 $E=mc^2$。\n\n```python\nprint(1)\n```\n' > "$FILES/notes.md"
  sips -s format png "$APP/Contents/Resources/icon.icns" --out "$FILES/figure.png" >/dev/null 2>&1

  # 文件树里的按钮文字是「文件名 时间」，目录是「目录名 计数」；报错页「尝试恢复」后树会收起，每个文件前都看一眼
  reveal() {
    local name="$1" dir="$2"
    [[ -z "$dir" ]] && return 0
    ax texts "$PID" | grep -q "^$name" && return 0
    press "展开 $dir" "$dir" --role AXButton
  }
  open_files() {
    local theme="$1"
    press "进项目" "示例课题（演示）" --exact --role AXButton || return
    press "进「文件」标签" "文件" --role AXRadioButton || return
    ax press "$PID" "刷新" --exact >/dev/null 2>&1; sleep 1
    for entry in README.md: references.bib: notes.md:smoke-files main.tex:smoke-files analysis.py:smoke-files \
      data.json:smoke-files table.csv:smoke-files page.html:smoke-files style.css:smoke-files app.js:smoke-files \
      mod.ts:smoke-files figure.png:smoke-files Liraglutide:papers; do
      local f="${entry%%:*}" dir="${entry#*:}"
      reveal "$f" "$dir"
      press "点开 $f（$theme）" "$f" --role AXButton && { sleep 2; check "预览 $f（$theme）"; }
    done
  }
  open_files "默认主题"

  log
  log "## 换浅色主题再看一遍"
  press "进设置" "设置" --exact --role AXButton
  press "进外观" "外观" --exact --role AXButton
  press "选浅色主题" "极简灰蓝 · 浅" --exact && check "换浅色主题"
  open_files "浅色主题"
  press "进设置" "设置" --exact --role AXButton
  press "进外观" "外观" --exact --role AXButton
  press "换回深色主题" "极简灰蓝" --exact
else
  FAILS=$((FAILS + 1))
  log "- ✗ 示例课题 60 秒内没出现，跳过文件预览"
fi

log
log "## 诊断页"
press "进设置" "设置" --exact --role AXButton
if press "进诊断" "诊断" --exact --role AXButton; then
  ax wait "$PID" "上次检测" 30 >/dev/null 2>&1
  check "诊断页"
  log
  log "依赖体检（沙盒按从访达双击的环境起，这里的有无就是新用户的有无）："
  log '```'
  # 一项 = ✓/✗ 后跟名称、版本、路径几行，拼成一行
  ax texts "$PID" | sed -n '/^依赖体检$/,/^上次检测/p' \
    | awk '/^(✓|✗)$/ { if (line) print line; line = $0; next } /^安装渠道$/ { if (line) print line; line = ""; next }
           line { line = line "  " $0 } END { if (line) print line }' >> "$REPORT"
  log '```'
  log
  log "应用日志里的 warn / error："
  log '```'
  errs="$(ax texts "$PID" | sed -n '/^应用日志$/,$p' | grep -E "\[(warn|error)\]" | cut -c1-400)"
  echo "${errs:-（无）}" >> "$REPORT"
  # 前端未捕获的异常、CSP 拦截都记成 error 级：有就算失败（整页没崩也是坏了）
  nerr="$(printf '%s\n' "$errs" | grep -c "\[error\]")"
  if [[ "$nerr" != 0 ]]; then
    FAILS=$((FAILS + 1))
    log "- ✗ 应用日志里有 $nerr 条 error（见上）"
  fi
  log '```'
fi

log
if [[ $FAILS == 0 ]]; then
  log "**结论：全部通过**"
else
  log "**结论：$FAILS 处失败**"
fi
echo "报告：$REPORT"
[[ $KEEP == 1 ]] && echo "沙盒实例留着：进程 $PID（kill $PID 结束）"
[[ $FAILS == 0 ]]
