# CLI 金丝雀（九家）

## 日常维护（只看这一节就够）

每天北京时间 9:17，GitHub Actions 的 **cli-canary** 在 macOS、Windows 各跑一次。你只看结果：

| 结果 | 意思 | 你要做的 |
|---|---|---|
| 绿 | 九家都没变，或者只是版本往前走了 | 什么都不用做。版本前移它已经自己提交回 main 了（提交信息「金丝雀核对版本前移」） |
| 红 | 某家的请求 / 旁路 / 会话 / 画面变了，或检查没过 | 点进那次运行看摘要（就是 report.md），按下面「红了怎么办」处理 |
| 仓库里多了 issue「上游有新的结构化通道：聊天层可以更接近上游」 | 某家 CLI 新出了能让聊天层少靠读屏的通道（不算红） | 按下面「上游通道雷达」处理 |

红了怎么办：
1. 看报告里是哪一家、哪一层变了，下面附了两个版本之间更新日志里沾边的条目。
2. 要改 Mesa 就改；判断不用改也行。
3. 在**报红的那个平台**上（macOS 红就在 Mac 上，Windows 红就在 Windows 上）跑：`npm run canary -- --accept --agents <那一家>`，
   把 `scripts/cli-canary/baseline/` 里变了的文件连同 Mesa 的改动一起提交。
4. 报告里写了新画面就顺手存进抓屏语料库（`tests/fixtures/screens/README.md`）。

记住两件事：
- 推送前先 `git pull`：CI 会往 main 提交版本前移。
- 核对版本除了打包时带进应用，装好的 Mesa 每半天还会从 main 取一次（`src-tauri/src/cli_verified.rs`，2026-11-04 起）：
  指纹没变、只是版本前移的，用户一天内就不再「未核对」；用 `--accept` 改过指纹的，旧版 Mesa 照旧降级，要等新版。

### 上游通道雷达（不算红）

聊天层能接近上游多少，取决于 CLI 给不给结构化通道（`docs/design-chat-fidelity.md`）。每次跑都会看三处线索：在伪终端里起一下 CLI、
看它问不问程序状态（OSC 7501，只在 macOS / Linux）；`--help` 里的 ACP、stream-json、本机服务、远程、hooks 一类开关；基线版本到这一版之间
更新日志里提到这些的条目。线索和 `upstream.json`（每家每条线索 Mesa 的结论：「用上：…」「不接：原因」「未定：…」）比，没登记过的、
以及更新日志里提到 Mesa 还没用上的通道的条目，写进报告最后一节，CI（macOS 那一路）开 / 追加 issue，同一条只提醒一次
（`upstream_issue.py`）。结论写了「不接」的通道，更新日志里 Fixed / Improved 开头的修 bug 条目只进报告、不开 issue，新增功能（Added 等）照旧提醒（2026-11-06，Claude 每版十来条 remote-control、`claude -p` 的修复天天开 issue）。2026-11-04 的来由：Kimi 2.4.0 的更新日志写了 OSC 7501，Mesa 隔了几版才偶然发现。

收到提醒怎么办（也可以直接交给 Agent：「按 issue 里的上游通道线索评估并接上」）：
1. 看是哪家、哪种通道。对照 `docs/design-chat-fidelity.md` §3「读屏债清单」：它能不能替掉这家某项靠读屏的能力？
2. 要接：照 2026-11-04 Kimi 程序状态那次走——先在本机实测 CLI 真这么做（伪终端探询 / 假网关 `e2e_channel`），再改 Mesa
   （`chat_channel.rs`、`chat-fidelity.ts` 分档），金丝雀把这家加进 `CHANNEL` 后 `--accept`，`upstream.json` 写「用上：…」。
3. 不接：在 `upstream.json` 写「不接：原因」（如「ACP 会取代终端界面」）。只想先压掉提醒：`npm run canary -- --accept-upstream`
   以「未定」登记，之后每次报告都会在「还没定的」里列出来。
4. 报告里「登记过、这次没探到的」= 上游撤了或改名，Mesa 用着的要赶紧核对。

本机跑（尤其在本机 accept 之前）先把各家升到最新：CLI 有新版时，Qwen 这类会在干净 HOME 里启动就自更新，更新提示一重绘就把发出去的那句吞掉，
旁路端到端整段报红（2026-10-25 Windows 实测 Qwen 0.26.0→0.26.1）。几家进程一起跑也会把 Gemini 拖慢到抓不到审批菜单，别和另一轮金丝雀同时跑。

想交给 Agent 做：发「按 docs/agent-skills/mesa-cli-canary/SKILL.md 做今天的金丝雀维护」，或把它装成技能（`docs/agent-skills/README.md`）。

各家 CLI 几乎每天发一版，默认行为常常没写进更新日志就变了。2026-10-21 的两次实例：Claude Code 新版对第三方模型把工具藏到工具搜索后面；
又不再给这类模型发任务清单工具。两次都是用户撞上才发现。金丝雀每天装最新版，把 Mesa 依赖的几层抽成「指纹」，和这里存的基线比，
变了就报。

| 层 | 看什么 | 来源 |
|---|---|---|
| 请求 | 主对话请求的工具清单、系统提示词小标题、用户这句之前注入的上下文标签、请求字段、`anthropic-beta` 等请求头 | 假网关 `E2E_DUMP` |
| 旁路 | Mesa `chat_channel` 端到端：认出会话、回合状态序列（比较时不看一闪而过的 `running`）、审批形态 | `e2e_channel`（`E2E_CLEAN_HOME` + `E2E_KEEP`） |
| 会话 | 会话文件的记录类型与字段；Mesa 解析器读出用户这句、工具调用 / 结果、回复 | 同上留下的 `transcript.jsonl` / `parsed.json` |
| 画面 | 审批菜单认不认得出、实时预览读不读得到 | `chat-capture.py`（`CLEAN_HOME`）+ `capture-check.ts` |
| Codex 提示词 | 本机 Codex 的默认提示词还取得到（Mesa 给 Codex 的 `base_instructions` 来源） | `codex_instructions_extract_real` |
| Claude 模型别名 | `claude --help` 举的别名 Mesa 都收了（名单 `tests/fixtures/claude-model-aliases.json`）；每个别名都换得出型号 | `model_aliases_probe_real` |
| Gemini 模型别名 | `tests/fixtures/gemini-model-aliases.json` 里每个别名都换得出型号（Gemini 帮助不列别名，新增别名靠更新日志） | `model_aliases_probe_real_gemini` |
| 全局配置 | 「设为全局」写进去的配置，外部直接用 CLI 时还认不认：模型是 `e2e-global`、密钥是 `sk-e2e-global`（假网关只记密钥末 8 位）。Cursor 不支持设为全局，不跑。临时 HOME 靠 `HOME` / `USERPROFILE`，Codex 另设 `CODEX_HOME`（Windows 上它不认这两个，会读本机 `~/.codex`）；写计划那一步去掉本机的搬迁变量，免得写进真实配置目录 | `e2e_write_global_config`（Mesa 真写计划写进临时 HOME）+ 各家无头命令（`global_phase`） |

跑法（仓库根目录，三平台同一个写法；`run.mjs` 会自己找能跑的 Python 3）：

```bash
npm run canary
```

- `--agents codex,qwen`：只跑这几家（默认九家；没装的跳过并写进报告）。
- `--accept-unchanged`：检查全过、指纹和基线一样、只是版本往前走了——只把基线的核对版本往前挪。
- `--skip-screen`：不抓屏，不需要 pyte。
- `--out <目录>`：指定明细落点，默认系统临时目录。

抓屏依赖（pyte，Windows 另加 pywinpty）缺了会自动 `pip install --target` 到 `CANARY_DEPS`，默认在系统临时目录下。
一家约 1–3 分钟，九家合计约 15–25 分钟，另加首次编译测试的时间。

**OpenCode 1.x / 2.x（2026-11-04）**：两版同命令名、同一个会话库，不能装在一起。金丝雀里 `opencode` 是 1.x 那份基线，`opencode2` 是 2.x 那份
（同一个 `opencode` 命令，Mesa 里仍是 opencode，按 `--version` 大版本分开走）；装的大版本不对就当没装、跳过。CI 先装 npm `opencode-ai` 跑完九家，
再换装 `@opencode/cli` 只跑 `opencode2`（目前只在 macOS；Windows 的 2.x 基线要在 Windows 上 `npm run canary -- --accept --agents opencode2`
建好，再把工作流里那一步的 `runner.os == 'macOS'` 去掉，并在 `src-tauri/src/cli_verified.rs` 的 `BUNDLED_EXTRA` 加上 win32 那份）。
本机装着 2.x 时只能跑 `opencode2`，要跑 `opencode` 得先换回 1.x。Mesa 认核对版本时 OpenCode 2.x 比 `opencode2` 那份（`chat-fidelity.ts baselineKey`）。

各家跑哪几层不一样：有结构化旁路的六家（Claude Code、CodeBuddy、Qwen、OpenCode、Codex、Grok）跑旁路端到端，
请求、旁路、会话、画面四层都比；Gemini、Kimi 不开全局 hooks、Cursor 没有旁路，只抓屏，请求形状取抓屏那一趟。
Grok 的程序状态不带会话 id，「旁路认出会话」这项不查，会话文件从临时 HOME 里扫出来。**Windows 上 Grok 也只抓屏**：程序状态（OSC 7501）
过不了 ConPTY，Mesa 在 Windows 不接这条旁路。Windows 上 Mesa 的会话扫描不认临时 HOME（`dirs::home_dir` 不看 HOME / USERPROFILE），
旁路没报会话文件时（Qwen、OpenCode）改在临时 HOME 里按会话 id 找，不会读到本机自己的对话。

不用真实密钥，请求只到本机假网关。临时 HOME **不拷本机配置**：用户自己的 MCP、插件、hooks 会改工具清单，那样各台机器和 CI 就没法比。
所以这里测的是「装好什么都不配的 CLI + Mesa 的注入」，「用户全局配置会不会盖过 Mesa」仍由 e2e-model-routing 的脚本核对。

## 结果怎么看

`<out>/report.md` 每家写三件事：
- 版本，以及基线核对到的版本。
- 检查过没过。检查是硬性的：旁路端到端通过、解析器读到工具来回等。
- 与基线比的每处变化，以及两个版本之间更新日志里沾边的条目。Claude 取 GitHub 上的 CHANGELOG，取不到读本机 `~/.claude/cache/changelog.md`；Codex 取 GitHub Releases。

明细在 `<out>/<agent>/`：
- `fingerprint.json`：这次的指纹。
- `channel/transcript.jsonl`：会话原件。
- `channel/parsed.json`：Mesa 解析结果。
- `screen.json`：逐帧画面。

`<out>/gateway-dump.jsonl` 是完整请求体，系统提示词原文在里面。报「假网关没起来」时看同目录的 `gateway-stderr.log`。

退出码：
- 0：没变化，检查全过。
- 1：有变化、检查没过，或还没有基线。
- 2：环境问题，没跑起来。

## 变了之后

1. 看 report.md 列的变化，对照 Mesa 用到的地方判断要不要适配。比如工具清单变了，看聊天层认不认得新工具；会话字段变了，看 `sessions.rs` 对应的解析器。
2. Mesa 改好后（或判断不用改），在**同一平台**上跑一次 `--accept`，把新指纹提交进 `baseline/<平台>/<agent>.json`。
   基线文件里的 `version` 就是「Mesa 已核对到的版本」。检查没全过时 `--accept` 会拒绝。
   **这个版本会随包进 Mesa**（`src/cli-verified.ts`；装好的 Mesa 另每半天从 main 取指纹没变的前移，`cli_verified.rs`）：用户装的比它新时，聊天层不替人自动按键、确认卡上提醒（`docs/design-chat-fidelity.md`）。
   所以基线要跟得上：CLI 版本前进而指纹没变时，跑一次 `--accept-unchanged` 把核对版本往前挪。
   CI 每天跑的就是 `--accept-unchanged`：全绿而只是版本前进时，工作流自己把 `baseline/` 提交回 main（有 `contents: write`，
   只动 `baseline/`）——所以本地推送前先 `git pull`。
4. 有新画面时顺手存进抓屏语料库：`scripts/screen-corpus/add-from-capture.ts <out>/<agent>/screen.json`（见 `tests/fixtures/screens/README.md`）。
3. 基线按平台分开存（`win32` / `darwin`）：两边的画面和跑的层本来就不同，比如 Windows 上 Grok 不跑旁路端到端。
   跟系统语言走的界面要钉成英文再记基线（Qwen 已由 `QWEN_CODE_LANG=en` 钉住），否则中文机器和 CI 记出来的菜单对不上。

CI：`.github/workflows/cli-canary.yml` 每天北京时间 9:17 在 macOS / Windows 各跑一次，也可以手动触发。
- 红了不是 Mesa 代码回退，是 CLI 变了。
- report.md 进运行摘要，明细在 artifact。
- 某个平台还没有基线时会一直报「无基线」：在那个平台本机跑一次 `--accept` 提交上来即可。
