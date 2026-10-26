#!/bin/sh
# 用法：先 npm run tauri:dev（17575 的 Vite 要在），再 sh scripts/chat-layout-measure/run.sh
# 对话样本放 harness.local/conv-{p50,p90,max}.json（README「准备样本」）
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin=/tmp/mesa-chat-layout-host
[ "$bin" -nt "$here/host.swift" ] || swiftc -O "$here/host.swift" -o "$bin"
base=http://127.0.0.1:17575/scripts/chat-layout-measure
for c in p50 p90 max; do
  for m in full page; do "$bin" "$base/switch.html?c=$c&mode=$m"; echo; done
  "$bin" "$base/scroll.html?c=$c"; echo
done
