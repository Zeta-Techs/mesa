---
name: mesa-cli-canary
description: Mesa（ccode）仓库让 Mesa 跟上九家 CLI 的维护。日常看 cli-canary 工作流的结果，分清环境故障、Mesa 自身问题还是某家 CLI 变了（含「设为全局」写进去的配置外部 CLI 还认不认）；CLI 变了就适配 Mesa、更新基线与抓屏语料库。发版前逐家复核官方配置文档，改连接 / 设为全局写法时按九条规则核对并用真 CLI 验证。最后用中文报告。用户说「做金丝雀维护」「看看金丝雀」「CLI 更新了聊天层 / 连接有没有坏」「设为全局外面不认了」「发版前复核各家配置文档」「检查哪家可以摘测试版」时使用。只在 Mesa 仓库根目录里用。
---

# Mesa CLI 金丝雀维护

Mesa 的聊天层建在九家 CLI（Claude Code、Codex、Gemini、Qwen Code、OpenCode、Kimi、CodeBuddy、Cursor、Grok）的终端上，连接页又替用户
把连接写进各家的配置文件（「设为全局默认」）。各家几乎每天发版，金丝雀每天装最新版，把 Mesa 依赖的四层（请求、旁路、会话文件、终端画面）抽成指纹，
和 `scripts/cli-canary/baseline/<平台>/<家>.json` 比；另有一层「全局配置」检查：Mesa 写进去的配置，外部直接用 CLI 时还认不认（2026-10-30 起）。

这个技能管三件事，按用户这次要的做：**日常维护**（第一～五步）、**发版前复核官方配置文档**（「发版前」一节）、**改连接 / 设为全局写法时的核对**（「改写法时」一节）。
基线里的 `version` 会随包进 Mesa：用户的 CLI 比它新时，聊天层不替人自动按键（`src/cli-verified.ts`）。你的工作是让这套东西一直是真的。

开始前读：`AGENTS.md`（仓库硬约束）、`scripts/cli-canary/README.md`、`docs/design-chat-fidelity.md`；涉及连接 / 设为全局时再读
`docs/conventions/profiles.md` §12 开头九条与 `docs/design-connection-agent-forms.md`。

## 不能做的事

- **不推送**，除非用户这次明确说了推送。
- **不切分支、不 rebase、不 stash、不 reset**。工作区不干净（有不是你改的文件）就只提交你自己改的文件，或者停下来报告。
- **没看懂的变化不 `--accept`**。基线是「Mesa 已核对过」的承诺，接受了就等于说聊天层在这个版本上没问题。
- **基线只在对应平台接受**：macOS 报红在 Mac 上 accept，Windows 报红在 Windows 上 accept。本机平台不对就写进报告交给用户。
- 不改用户本机的 CLI 配置（`~/.claude`、`~/.codex` 等），金丝雀用临时 HOME，你也不需要碰它们。
- 不删 `tests/fixtures/screens/` 里的老样本（用户可能还在用老版本）。
- 改「测试版」开关（`src/chat-fidelity.ts` 的 `beta`）是产品决定：只列出达标的家，等用户点头再改。

## 准备

```bash
git branch --show-current          # 必须是 main，不是就停下报告
git status --short                 # 有别人的改动也照常做，但提交时只加自己的文件
git pull --ff-only                 # 仅在工作区干净时；CI 会往 main 提交「金丝雀核对版本前移」
gh auth status                     # 要能读这个仓库的 Actions
```

Rust 不在默认 PATH 时先 `export PATH="$HOME/.cargo/bin:$PATH"`。本地跑金丝雀统一 `npm run canary`（三平台同一写法）。

## 第一步：看最近一次运行

```bash
gh run list --workflow cli-canary.yml --limit 3
gh run view <运行号> --json jobs,headSha --jq '.headSha, (.jobs[] | "\(.name) \(.conclusion)")'
git log --oneline <headSha>..main -- scripts/cli-canary scripts/e2e-model-routing src-tauri/build.rs .github/workflows/cli-canary.yml
```

先看最后一行：有输出说明那次运行之后 main 上又修过金丝雀本身，它的失败可能已经过时。这时不按它下结论——
要在 CI 上复核得先推送 main 再 `gh workflow run cli-canary.yml`（推送要用户点头），或者先在本机平台复现。

- **两个平台都 success**：读那次运行的摘要（`gh run view <运行号>`，摘要就是 report.md），记下各家版本；看 main 上有没有「金丝雀核对版本前移」的新提交。没别的事，直接写报告。
- **有 failure**：继续第二步。

## 第二步：分清是哪一类失败

```bash
mkdir -p /tmp/canary-<运行号> && gh run download <运行号> --dir /tmp/canary-<运行号>
ls /tmp/canary-<运行号>/*/            # canary-macos-latest / canary-windows-latest
```

| 现象 | 是什么 | 怎么办 |
|---|---|---|
| 没有 `report.md`，日志里是装依赖失败（rustup / npm / pip / curl 超时、网络错误） | 环境故障 | `gh run rerun <运行号> --failed`，报告里记一笔，不动代码 |
| 没有 `report.md`，日志最后是「假网关没起来」 | 金丝雀脚本自己的问题 | 看 artifact 里的 `gateway-stderr.log`：有报错按报错修 `scripts/e2e-model-routing/gateway.py`；空的说明网关起得慢（2026-10-25 先例：`HTTPServer` 监听前的 `getfqdn` 反查在 macOS runner 上卡住，网关已改成跳过反查） |
| 没有 `report.md`，有 `plans-error.txt`，或测试进程起不来（如 Windows `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`） | Mesa 自己的编译 / 测试问题，不是 CLI 变了 | 再看主线 `gh run list --workflow build.yml --limit 3` 是否同样红。作为单独的修复报告给用户（主线 CI 必须绿），**不动基线**。Windows 的 `0xc0000139` 已由 `src-tauri/build.rs` 给测试 exe 嵌 manifest 修掉，再出现说明有人退回了 `tauri_build::build()`（见 environment.md） |
| 有 `report.md` | 金丝雀跑完了 | 第三步 |

**同一个错连着出现几天，就不是环境抖动**：归成「环境故障」重跑之前，先 `gh run list --workflow cli-canary.yml --limit 5` 看前几次是不是同样死在这一步（2026-10-22～24 macOS 天天「假网关没起来」，重跑救不了）。

## 第三步：逐家处理 report.md

每家一节，看三行：版本（基线核对到哪个版本）、检查（全过 / 没过哪些）、与基线比（没有变化 / N 处变化 / 无基线）。

| 报告写的 | 意思 | 处理 |
|---|---|---|
| 没装、跳过 | CI 没装上这家 | 看 `.github/workflows/cli-canary.yml` 的安装步骤，报告给用户 |
| 无基线 | 这个平台还没核对过这家 | 本机平台相同：`npm run canary -- --accept --agents <家>`（检查必须全过）；不同就交给用户 |
| 检查没过 | Mesa 依赖的东西断了 | 本机复现（下面），找原因，修。**CI 上没过、本机却过**：先在命令前加 `CI=true GITHUB_ACTIONS=true` 复现——CLI 见到 CI 变量会走无头模式或不画动态界面（`canary.py` 已在启动时去掉这些变量，2026-10-25；再出现说明有家认了新的变量名，补进 `CI_ENV`） |
| N 处变化 | 某一层的形状变了 | 按下表判断要不要适配 |

本机复现某一家（先把这家 CLI 升到最新：本机版本落后时 Qwen 这类会在干净 HOME 里启动就自更新，把发出去的那句吞掉，旁路整段报红；也别和另一轮金丝雀同时跑）：

```bash
npm run canary -- --agents <家> --out /tmp/canary-local
# 明细：/tmp/canary-local/<家>/channel.log、screen.log、fingerprint.json、channel/transcript.jsonl、channel/parsed.json、screen.json
```

变化在哪一层 → 看 Mesa 哪里：

| 层（指纹里的键） | 管什么 | Mesa 里对应的代码 |
|---|---|---|
| `request` | 发给模型的请求：工具清单、系统提示词小标题、请求头 | `src-tauri/src/agents.rs`（启动参数与注入）、`docs/agent-integration-matrix.md` 这家那一节 |
| `channel` | 结构化旁路：回合状态、审批形态（`statuses` 是 Mesa 归一后的名字；一闪而过的 `running` 不参与比较，少了 `awaiting_approval` / `completed` 才是真断） | `src-tauri/src/chat_channel.rs`、`src-tauri/src/program_status.rs` |
| `transcript` / `parsed` | 会话文件格式与 Mesa 解析器读出的对话 | `src-tauri/src/sessions.rs` 里这家的 `parse_*` |
| `screen` | 读屏：审批菜单、边写边显示 | `src/tui-menu.ts`、`src/live-reply.ts`、`src/trust-prompt.ts` |
| 检查「全局配置：…」 | 「设为全局」写进去的配置外部 CLI 还认不认（模型 / 密钥没用上 = CLI 改了配置格式或优先级） | `src-tauri/src/global_config.rs` 这家的 `patch_*`，规则见 `docs/conventions/profiles.md` §12 开头九条 |

判断要不要适配：报告底下附了两个版本之间更新日志里沾边的条目，先看它；再用 `fingerprint.json` 和基线文件逐项对比。
- 画面变化只是同一菜单换了语言（中文 ↔ 英文）：是机器环境不同，不是 CLI 变了。`canary.py` 已用 `QWEN_CODE_LANG=en` 钉住 Qwen；别家也按系统语言走的话，照样找它的语言环境变量钉成英文，再在该平台重新 `--accept`。
- 同版本、同代码，这次没过上次过（多见于「这一轮走完」没过、回合状态只有 `-`）：先当时序问题，看 `channel.log` 的屏幕尾部是不是停在空输入框。e2e 与抓屏都等画面安静 1.5 秒（最多 45 秒）才输入，仍不够就调这两处，不动基线。
- 只是新增了 Mesa 不用的字段 / 工具：不用改，写明理由。
- 聊天层会显示错、认不出菜单、读不到工具或回复：要改。改完对应层要有测试（Rust 单测、`tests/*.test.ts`），画面问题还要存语料库样本。

改好（或判断不用改）后，在报红的平台上：

```bash
npm run canary -- --accept --agents <家>
git diff scripts/cli-canary/baseline/
```

`--accept` 会把这家重跑一遍再记，记下的是重跑的结果，不是你刚看过的那次：提交前看一眼 `git diff`，变化要和你判断过的那处对得上，对不上就别提交、回去查。

### 「全局配置：…」检查没过

这一层（`canary.py global_phase`）用 Mesa 真实的设为全局写计划（`global_config.rs e2e_write_global_config`）把配置写进临时 HOME，
不经 Mesa 直接起 CLI 的无头命令问一句，看假网关收到的模型是不是 `e2e-global`、密钥末 8 位是不是 `sk-e2e-global` 的。明细在
`<out>/<家>/global-write.log`（写了哪些文件）与 `global-run.log`（CLI 的输出）。

| 现象 | 多半是 | 怎么查 |
|---|---|---|
| 模型对、密钥不对（末 8 位像 `API_KEY}`） | 配置里的变量引用没展开 | 引用靠 CLI 内部时序的不可靠（CodeBuddy 的 `${VAR}` 早于 settings env 灌入展开，2026-10-31 起 Mesa 改写明文，见 matrix §7）；连跑几次看是不是时好时坏，时好时坏就别再用引用；稳定不展开再查这家文档的变量引用写法变了没有 |
| Windows 上 Codex 两项都不过、日志里是本机模型 | 只改 `USERPROFILE` 时 Codex 读真实 `~/.codex` | `global_phase` 给 Codex 钉 `CODEX_HOME`；新增 Rust 写的 CLI 也要钉它自己的搬迁变量 |
| 一个请求都没到假网关、`exit timeout` | CLI 没走配置里的地址，或被代理挡了 | 看 `global-run.log`：报没登录 = 密钥位置不认了（Grok 1.0.70 不读顶层 `api_key` 的先例）；什么都没有 = 先确认 `NO_PROXY=127.0.0.1,localhost` 在（Grok 带断网代理） |
| 请求到了但模型是别的 | 配置优先级 / 默认模型字段变了 | 对照这家官方配置文档（「发版前」一节的来源表）找新的默认模型键；Gemini 再看 `~/.gemini/.env` 是否因目录信任没读 |
| `global-write.log` 里测试失败 | Mesa 写计划本身报错 | 按报错修 `global_config.rs`，不是 CLI 变了 |

修好后照第三步 `--accept`（这层只是检查项、不进指纹，基线不变也要检查全过才算绿）。

## 第四步：新画面存进抓屏语料库

金丝雀抓到新版本的画面，或你修了一个读屏问题：

```bash
node --experimental-strip-types scripts/screen-corpus/add-from-capture.ts /tmp/canary-local/<家>/screen.json --version <版本> --platform <darwin|win32> --dry
```

先看 `--dry` 打出来的读屏结果对不对：对了去掉 `--dry` 再跑一次存下；不对先修解析器，或者手改样本里的 `expect` 写成该读出的样子。规则见 `tests/fixtures/screens/README.md`。

## 第五步：验证与提交

按改到的那一侧跑基线再提交（AGENTS.md 硬约束「git 提交与单人开发流程」①；改了前端 `npm run build` 一定要跑——`node --test` 不做类型检查；只改了 `baseline/` 指纹不用跑）。两侧都改时三样全跑：

```bash
npm test
(cd src-tauri && cargo test)
npm run build
```

- 一个适配一个提交；这家的基线文件跟着它的适配一起提交。只接受基线、没改代码的，单独一个提交。
- 提交信息中文，第一行「fix：/ chore：」+ 改了什么，正文写为什么（哪个版本、哪一层变了）。
- 只 `git add` 你改的文件。
- 涉及用户能看到的变化，照 AGENTS.md 同步 `CHANGELOG.md`「未发布」段和 `docs/guide/user-guide.md`。

## 发版前：逐家复核官方配置文档

金丝雀只发现「行为变了」，发现不了「官方新出了更好的写法」（2026-10-30 的先例：CodeBuddy 的 `models.json`、Claude 的 `effortLevel`、
Qwen 官方登录停用都是读文档才发现的）。每次发版前（architecture §12「发布前检查项」）做一轮，耗时大的话可以三家一组并行交给子任务，但每家结论你自己核。

| 家 | 官方来源（先看更新日志，再看配置页） | Mesa 写法在哪 |
|---|---|---|
| Claude Code | code.claude.com/docs/en/settings、model-config、env-vars；CHANGELOG.md | `global_config.rs patch_claude_settings`、`agents.rs claude_model_env` |
| Codex | github.com/openai/codex `docs/config.md`、learn.chatgpt.com 的 config 文档；Releases | `patch_codex_config` / `patch_codex_relay_extras` |
| Gemini CLI | github.com/google-gemini/gemini-cli `docs/` 的 configuration、authentication；Releases | `patch_gemini_settings` / `patch_gemini_extras` / `.env` |
| Qwen Code | qwenlm.github.io/qwen-code-docs 的 configuration / auth；本机 bundle | `patch_qwen_settings` |
| OpenCode | opencode.ai/docs/config、providers、models | `patch_opencode_config`、`agents.rs opencode_provider_json` |
| Kimi Code | moonshotai.github.io/kimi-cli 的 configuration；本机二进制 strings | `patch_kimi_config` / `patch_kimi_effort` |
| CodeBuddy | codebuddy.ai/docs/cli 的 settings、models、env-vars | `patch_codebuddy_settings` / `patch_codebuddy_models` |
| Grok Build | 本机 `~/.grok/docs/user-guide/`（02-authentication、11-custom-models、26-config-reference） | `patch_grok_config` |
| Cursor | cursor.com/docs/cli/reference/configuration、authentication | 不支持设为全局（`agent_specs.rs` 理由） |

每家对四件事：① Mesa 写的键名 / 位置还认不认、有没有改名；② 有没有更高优先级的来源会盖过（新的环境变量、项目级 / 托管配置）；
③ 有没有能落盘的新字段可以补上「启动有、全局漏」的设置；④ 认证 / 官方登录有没有变（停用、换方式）。结论写进 `docs/agent-integration-matrix.md`
这家那一节（带日期与依据：文档 URL、版本号或实测）。要改写法的，按下一节做。没有变化也在报告里写一句「已复核，无变化」。

## 改写法时：九条规则 + 真 CLI 验证

改任何一家的设为全局写计划、启动注入或连接表单前，逐条对照 `docs/conventions/profiles.md` §12 开头九条（目录同源、与启动同源、只管自己的键先清再写、
写前说清盖掉来源、写用户层、官方切回只撤自己的、被引用文件不删、能引用不写明文、金丝雀复核）。另外：
- **新写法上线前用真 CLI + 假网关跑一遍**，静态审查代替不了（AGENTS「动真实数据先干跑」）：`npm run canary -- --agents <家> --skip-screen` 会跑「全局配置」层；
  只想快速看一家，可按 `scripts/cli-canary/README.md`「全局配置」一行的做法单跑 `e2e_write_global_config` 再手动起 CLI。临时 HOME 建在用户目录下。
- **双端镜像要同改**：Claude 别名槽（`agents.rs claude_slot_models` ↔ `src/role-models.ts claudeAliasMap`，共读 `tests/fixtures/claude-slots.json`）；
  通道表 `request_policy_support` 的 `persist` 格子与写盘函数由 `policy_channel_table_agrees_with_patch_functions` 互锁，改一边测试会拦。
- 连接弹层「看实际会拿到什么」（`EffectPreview`）显示的就是 `preview_launch_plan` / `preview_profile_global` 的结果：改完自己打开看一眼对不对。
- 用户看得见的变化同步 `CHANGELOG.md` 与 `docs/guide/user-guide.md` 第 9 章。

## 每两周一次：哪些家可以摘「测试版」

条件（`docs/design-chat-fidelity.md` §4）：这家连续两周金丝雀没报红，且「转到终端」计数里「等确认，聊天卡上认不出菜单」「等确认，这家没有精确状态」基本为 0。

```bash
gh run list --workflow cli-canary.yml --limit 14 --json conclusion,createdAt
# 计数在用户本机 Mesa 的数据库里：macOS ~/Library/Application Support/ccode/app.db；Windows %APPDATA%\ccode\app.db；Linux ~/.config/ccode/app.db
sqlite3 "<app.db 路径>" "SELECT agent, reason, detail, SUM(count) FROM chat_handoff_events WHERE day >= date('now','-14 day') GROUP BY agent, reason, detail ORDER BY 4 DESC;"
```

只读这个数据库，不写。列出达标的家，等用户确认后再把 `CHAT_FIDELITY` 里那家的 `beta` 改成 `false`，同步说明书里列「测试版」的那句。

## 报告（中文，最后一条消息）

```
## 金丝雀维护 · <日期>

| 家 | 版本 | 结果 | 全局配置 | 处理 |
|---|---|---|---|---|
| claude-code | 2.1.310 | 绿 | 认 | — |
| qwen | 0.26.0 | 画面变了 | 认 | 修了 live-reply 的 xx，新样本已存，基线已接受（darwin） |
| …

（发版前复核时另加一节「官方配置文档复核」：每家一行，变了什么 / 无变化，依据链接。）

- 环境故障：<有就写，重跑了没有>
- Mesa 自身问题：<如主线 CI 红、Windows 测试起不来>
- 等你决定：<要在 Windows 上 accept 的家 / 可以摘测试版的家 / 要不要推送>
- 提醒：基线有更新的话，要发新版 Mesa 用户才拿得到
```
