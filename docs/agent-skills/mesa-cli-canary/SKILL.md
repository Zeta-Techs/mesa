---
name: mesa-cli-canary
description: Mesa（ccode）仓库的 CLI 金丝雀日常维护。看每天 cli-canary 工作流的结果，分清是环境故障、Mesa 自身问题还是某家 CLI 变了；CLI 变了就适配 Mesa、更新基线与抓屏语料库，最后用中文报告。用户说「做金丝雀维护」「看看金丝雀」「CLI 更新了聊天层有没有坏」「检查哪家可以摘测试版」时使用。只在 Mesa 仓库根目录里用。
---

# Mesa CLI 金丝雀维护

Mesa 的聊天层建在九家 CLI（Claude Code、Codex、Gemini、Qwen Code、OpenCode、Kimi、CodeBuddy、Cursor、Grok）的终端上。
各家几乎每天发版，金丝雀每天装最新版，把 Mesa 依赖的四层（请求、旁路、会话文件、终端画面）抽成指纹，和 `scripts/cli-canary/baseline/<平台>/<家>.json` 比。
基线里的 `version` 会随包进 Mesa：用户的 CLI 比它新时，聊天层不替人自动按键（`src/cli-verified.ts`）。你的工作是让这套东西一直是真的。

开始前读：`AGENTS.md`（仓库硬约束）、`scripts/cli-canary/README.md`、`docs/design-chat-fidelity.md`。

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

## 第四步：新画面存进抓屏语料库

金丝雀抓到新版本的画面，或你修了一个读屏问题：

```bash
node --experimental-strip-types scripts/screen-corpus/add-from-capture.ts /tmp/canary-local/<家>/screen.json --version <版本> --platform <darwin|win32> --dry
```

先看 `--dry` 打出来的读屏结果对不对：对了去掉 `--dry` 再跑一次存下；不对先修解析器，或者手改样本里的 `expect` 写成该读出的样子。规则见 `tests/fixtures/screens/README.md`。

## 第五步：验证与提交

三套基线全绿才提交（AGENTS.md 硬约束；`node --test` 不做类型检查，`npm run build` 一定要跑）：

```bash
npm test
(cd src-tauri && cargo test)
npm run build
```

- 一个适配一个提交；这家的基线文件跟着它的适配一起提交。只接受基线、没改代码的，单独一个提交。
- 提交信息中文，第一行「fix：/ chore：」+ 改了什么，正文写为什么（哪个版本、哪一层变了）。
- 只 `git add` 你改的文件。
- 涉及用户能看到的变化，照 AGENTS.md 同步 `CHANGELOG.md`「未发布」段和 `docs/guide/user-guide.md`。

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

| 家 | 版本 | 结果 | 处理 |
|---|---|---|---|
| claude-code | 2.1.310 | 绿 | — |
| qwen | 0.26.0 | 画面变了 | 修了 live-reply 的 xx，新样本已存，基线已接受（darwin） |
| …

- 环境故障：<有就写，重跑了没有>
- Mesa 自身问题：<如主线 CI 红、Windows 测试起不来>
- 等你决定：<要在 Windows 上 accept 的家 / 可以摘测试版的家 / 要不要推送>
- 提醒：基线有更新的话，要发新版 Mesa 用户才拿得到
```
