# 聊天层回放台

聊天层的显示问题（回复闪一下、整段消失、同一句出现两次、过程区展开又收起、误弹「终端在等你」）多半只在某个时机才出现：
会话文件比「这轮结束」信号早到还是晚到、CLI 这一版换了画法、工具正在跑……靠人点很难碰上，也说不清是哪一步。
这里把**真 CLI 的终端画面**按 Mesa 读屏的节奏喂给**真的聊天层组件**，每 40ms 记一次画面，自动判有没有出问题。
不用开 Mesa，不花 token，不碰真实会话目录。

三件：

| 脚本 | 做什么 |
|---|---|
| `timeline.ts` | 抓屏原文 → Mesa 读到的实时预览序列（300ms 节流带尾读、半帧不读，同 `TerminalView.scanLiveReplyNow`）；`--markdown` 给不读屏的家（Codex / Qwen / OpenCode 旁路推 Markdown）造同形序列 |
| `surface.mjs` | 用序列驱动真 `ChatSurface`（JSDOM，Tauri 打桩），回合结束后按 `--delay` 把会话文件的最终消息接上，报重复 / 闪没 / 消失 / 等你卡 / 过程区变化；有问题退出码 1 |
| `box-check.ts` | 逐块读屏调 `terminalHasInputBox`，报「认出过输入框之后又读成没有」几次（那时静 4 秒就弹「终端在等你」、预览也读不出） |

`samples/three-files.md` 是一份带小标题、长段落、表格的长回复（假网关 `E2E_LONG_FILE` 用它流出，`surface.mjs` 拿它当最终消息）。

## 一次完整的跑法

抓屏用 `scripts/e2e-model-routing/` 的假网关和 `chat-capture.py`（依赖、启动计划的生成见那边的 README）：

```bash
E2E_LONG_FILE=scripts/chat-replay/samples/three-files.md E2E_LONG_CHUNK=6 E2E_LONG_DELAY=0.03 \
  python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
CAP_RAW=1 CAP_COLS=150 CAP_ROWS=53 REPLY_PROMPT="TRIGGER_LONG 写长一点" REPLY_SECS=30 IDLE_FOCUS="in,out" IDLE_SECS=3 \
  TOOL_PROMPT="/rename 只读对比三个文件" TOOL_SECS=8 PYTE_DIR=/tmp/pyte \
  python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json claude-code auto /tmp/cap/claude.json

node --experimental-strip-types scripts/chat-replay/box-check.ts /tmp/cap/claude.json
node --experimental-strip-types scripts/chat-replay/timeline.ts /tmp/cap/claude.json /tmp/tl.json --until 来改
for d in -300 0 350 1500 4500; do node scripts/chat-replay/surface.mjs /tmp/tl.json scripts/chat-replay/samples/three-files.md --delay=$d; done
```

`--until 来改`：样例回复最后一句里有「来改」，读到它再收一帧就停，后面一幕（`/rename`）不算这一轮。
负的延迟要写成 `--delay=-300`（不连等号会被当成另一个选项）。

## 常用场景

- **会话文件落盘时机**：`--delay` 取 −300 / 0 / 350 / 700 / 1500 / 4500，覆盖「文件先到、信号后到」到「晚过收尾时限」。
- **不读屏的家**：`timeline.ts --markdown samples/three-files.md /tmp/tl-md.json`，再 `surface.mjs /tmp/tl-md.json … --agent codex`（原生模式再加 `--channel claude-native` / `acp` / `codex` / `qwen` / `opencode`，同步喂实时思考与旁路状态）。
- **带工具调用的一轮**：假网关起时加 `E2E_PROBE_CMD="sleep 3; echo mesa > mesa_probe.txt"` 与 `E2E_DONE_TEXT=<回复>`，
  抓屏用完全访问档 `full`、`REPLY_PROMPT="TRIGGER_TOOL 跑一下"`；`timeline.ts … --mark TRIGGER_TOOL`，
  `surface.mjs … <回复.md> --tool-flow 0.85,3.6`（工具头画出来、工具跑完的时刻，从 `--snap` 或抓屏里看）。
- **同一会话的第二轮**：第一轮发 `TRIGGER_SLOW`、第二轮发 `TRIGGER_LONG`（假网关先认 `TRIGGER_LONG`，反过来第二轮会把长回复再回一遍），
  `surface.mjs … --prev-reply <第一轮回复.md> --prev-prompt "TRIGGER_SLOW 讲一段" --prompt "TRIGGER_LONG 写长一点"`。
- **看某一刻画成什么样**：`--snap 9.6,9.95`（打印对话区结构），加 `--grep <一段字>` 只打印含它的那个元素的 HTML。

## 怎么读结果

- **重复 / 闪没 / 消失**：判定句默认从最终回复里自动挑（首、中、尾几行、回复里只出现一次的），`--keys "a|b"` 自己指定。
  过程区里的工具说明在这一轮结束时收起，「消失」属正常，别把它放进 `--keys`。
- **过程标签 / 折叠容器**：「已工作」「已思考」与 `.ccode-collapse` 出现、消失的时刻；结束时多出一段收起动画就看这里。
- **文字总长骤降**：读屏预览里的表格是终端画的框线，落盘后换成真表格，字数会少一截，属正常；生成中途的骤降才要看。
- **控制台错误**：组件报错（多是打桩的后端命令返回形状不对，`surface.mjs` 里的 `__invoke`）。出现时画面会整块空，先修桩再看结论。

## 2026-11-25 查出并修掉的

- 会话文件晚于 4 秒落盘：回复整段空约半秒（九家同样）→ `chat-handoff.ts settleHoldMs`。
- Claude Code 2.1.326 跑命令时工具头写成说明文字，被当成回复挂在预览里 → `live-reply.ts toolHeadAbove`。
- Gemini 跑全局 hooks 时状态行「Executing Hooks: …」混进预览 → gemini 布局 `skip`。
- Claude / Qwen / Grok 会话起名后输入框上沿写着名字、认不出输入框（`box-check.ts`）→ `promptTopRule` / `BOX_TOP`。

还看得到、没改的：会话文件比结束信号早约 0.3 秒到时，回复上方先多一行「思考 N 秒」、下面出「思考中」，随后收成「已思考」
（Mesa 还没收到结束信号，改「进行中的一轮不切回答」也消不掉）；Claude 重绘半途偶有一帧少个字，下一次读屏就好。
