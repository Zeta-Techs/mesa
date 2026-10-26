# 聊天区量测：切到一段对话后字动不动、往上翻顺不顺

用你本机的真实对话，在 Mac 真正的网页内核（WKWebView，Mesa 在 Mac 上就是它）里跑聊天层，逐帧看画面。
改了聊天区（`ChatSurface` / `ConversationView` / `ChatMarkdown` / `virtual-window.ts` / `reading-anchor.ts`），
或往对话里加了会晚到的内容（新卡片、新的行内加工）之后跑一遍，看有没有回退。只能在 Mac 上跑，不进 CI。

## 准备样本

真实对话不进仓库，写在 `harness.local/`（gitignored）。从一个 Claude Code 项目目录里取三段（中位、九成位、最大）：

```bash
cd src-tauri && MESA_CHAT_SAMPLES=~/.claude/projects/<项目目录> cargo test --lib dump_chat_layout_samples -- --ignored
```

## 跑

先开着 `npm run tauri:dev`（要用它 17575 端口的 Vite），然后：

```bash
sh scripts/chat-layout-measure/run.sh
```

每段对话三行结果：

- `switch.html?mode=full`：整段一次到（看过的、点开前等到了的）。
- `switch.html?mode=page`：先到最近一页，120ms 后整段接上（第一次点开、后端慢的时候）。
  `firstTextMs` 是第一帧出字的时刻，`visibleMoves` 是之后画面上的字换了几次，应为 0，换了的在 `log` 里写着前后各是哪几个字。
- `scroll.html`：从底部一步 90px 往上翻。`contentJumps`（视野中间那块没跟着正好挪 90px 的次数）和
  `foreignScrollWrites`（翻的途中别人改了滚动位置的次数）应为 0，`atBottom` 应为 true（刚摆出来停在底部）。

## 量的口径

- 在每一帧画完之后看探针点下的字（rAF 回调跑在 ResizeObserver 校正之前，那时的位置还不是画上屏的）；
  画完到量之间插进了别的任务的那一帧不算，量到的是下一帧绘制前会被校正掉的中间态。
- 往上翻的滚动写在任务里做，像真的滚轮：下一帧先发滚动事件、再跑 ResizeObserver。在 rAF 里写会把阅读锚点的正常校正量成跳动。
- 页面里没有 Tauri，`mock.js` 给要问后端的几样一个慢 90ms 的假回答（行内文件链接按「都是文件」）。
- 屏外窗口默认被当成被挡住，rAF 停、计时器变慢，`host.swift` 用私有接口关掉遮挡检测。
