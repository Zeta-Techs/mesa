# AGENTS.md

> **体积硬上限（2026-11-23 用户拍板）**：本文件总大小必须控制在 **22 KB 以内**（Antigravity 等 Agent 平台单规则文件上限 24 KB，超出会被直接截断）。
> 本文件只放**每次会话都要守的硬约束、提交流程、构建命令与索引**；单一领域的产品决策与细则一律写进 `docs/conventions/product-decisions.md` 或对应 `docs/conventions/*.md`，这里只留指针。

## 一、核心协作与省力原则

- **省力原则（2026-10-26）**：每次会话只需读本文件，其余文档**按需 Grep 检索、不通读**。`docs/architecture.md`、`docs/code-structure.md`、`docs/conventions/*.md` 只读命中的小节；architecture §10 是新在前的日志，按关键词搜、同一主题以最新一条为准。按改动范围决定读什么、跑什么、改哪些文档；日常局部改动按「分层测试基线」跑定向测试与增量类型检查，跨模块公共契约或发版前跑全量基线。
- **规则沉淀**：重大拍板/取舍/否决记入 `docs/conventions/product-decisions.md`（或对应领域 `conventions/*.md`）与 `docs/architecture.md` §10；**不记操作流水账**。纯修 bug、重构、补测试只写提交信息，不进 §10。
- **边走边改（2026-09-22）**：用户走科研流程时的提问和反馈，默认是要改他正在用的那条流程（课题档案卡 + 模板/任务书/界面），不是要一段说明；先核对实际落盘和界面再改，改到能接着用并写清改了什么、在哪能看见。
- **动真实数据先干跑 + 未发布不养闲机器（2026-10-13）**：写用户真实项目数据的功能（迁移/清理/批量改写），交用户点前必须在干跑环境或真实项目副本上完整跑通；只服务假想老用户的迁移界面不留（细则见 `product-decisions.md` §四）。
- **外部桌面软件先挖原生接口（2026-11-16）**：禁止脆弱的键鼠界面模拟点击和无人值守操控文档插件（如 Word CWYW），但必须第一时间拆查目标软件的官方原生接口（macOS `.sdef` AppleScript、CLI、URL Scheme、只读索引）直接闭环；确需人点外部窗口的回退路径必须真机走完默认目录与默认选项（细则 `pipeline.md`「科研外部工具与交付合同」）。
- **跨平台换行**：仓库文本文件统一 LF（`.gitattributes`），提交前不得带入 CRLF 全文件差异。

## 二、Git 提交、文档同步与分支纪律（每次任务必守）

### 1. 做完一处就同步文档并提交（2026-10-26 用户拍板）

- **不攒不拖**：一个问题 / 一处改动做完、验过，**当场**按下方「文档同步」表更新受影响文档、跑对应侧基线、**立即自己提交**，不要停着等用户回头说「提交」（用户明确说先别提交的除外）。
- **一个主题一个提交**：禁止攒多主题「一系列修复」大杂烩提交。
- **按改动范围分层跑测试基线（2026-11-23 用户拍板）**：
  - 只改文档：不跑测试；
  - **局部改动（单一组件 / 页面 / 文案 / 单个模块修小问题）**：
    - 只改前端：跑**受影响的定向测试文件**（`node --experimental-strip-types --import ./tests/dom-safe-assert.ts --test tests/<相关>.test.ts`）+ **`npm run typecheck`**（走增量 `tsc --noEmit`，无需每次跑 `vite build` 全量生产打包）；
    - 只改 Rust：跑**受影响模块的定向测试**（`cd src-tauri && cargo test <模块名或用例名>`）；
  - **跨模块 / 共用契约 / 构建或依赖改动 / 发版前**（动了 `tests/fixtures/`、Tauri 命令签名、共用 DTO 字段、双端镜像逻辑、`package.json` / `Cargo.toml` / `vite.config.ts`）：跑对应侧或三样全量基线（`npm test`、`npm run build`、`cd src-tauri && cargo test`）。
  - **测试基线必须全绿**：存量失败不修会淹没新问题；CI 在 macOS + Windows 三样全跑兜底，红了当次处理（纯文档提交可加 `[skip ci]`）。

### 2. 只提交本会话自己的改动（2026-11-13 用户拍板）

同一 checkout 常有多个会话并行，**工作区里别人的改动（含未完成文件）一律不碰**。提交流程必须走**私有暂存区**：

1. 整文件放入前先 `git diff <文件>` 确认没有别人的块；共用文档（`CHANGELOG.md`、`user-guide.md`、`code-structure.md`、`architecture.md`）只放自己那几处。
2. 用临时 `GIT_INDEX_FILE` 从当前 `HEAD` 起底，只放入本会话文件/片段并创建提交：
   - `H=$(git rev-parse HEAD)`，`GIT_INDEX_FILE=/tmp/mesa-idx-$$` 起底 `git read-tree "$H"`；
   - 仅把自己的文件/patch 加入私有暂存区（zsh 里文件清单写成数组）；
   - `T=$(git write-tree)` → `C=$(git commit-tree "$T" -p "$H" -m "...")` → `git update-ref HEAD "$C" "$H"`（若 `HEAD` 中途被别人推进则失败重来；跑过基线的提交不用 `git commit`）；
   - 成功后同一条命令里 `git reset -q -- <这些文件>` 对齐共享暂存区，再删临时 index 文件。
3. 提交后必须 `git show --stat HEAD` 核对文件数与文件名全是自己的；若误带走或误撤别人的改动，**禁止 `amend` / `rebase`**，往前补一个提交并告知对方会话。

### 3. 提交信息格式与分支纪律

- **格式（2026-11-16）**：第一行 `类型(范围): 中文说明`——类型仅用小写 `feat / fix / ui / docs / test / refactor / perf / chore / release`，范围可省，**半角冒号加一个空格**，中文说明不加句号；合并提交写 `chore: 合并 origin/main，…`；已推送历史禁止 `amend` / `rebase`。
- **分支纪律**：日常直接在 `main` 开发，大功能/实验开分支（`feat/...`）再 `git merge --no-ff` 回 `main`。未经用户明确指令，禁止 `checkout / switch / merge / rebase / stash` 或删分支；开工先 `git branch --show-current` 确认分支，收尾报告分支名 + `git status` 概况。
- **推送与发版**：走 SSH:443 + deploy key；发版版本号三处同步、模型库刷新、CHANGELOG 驱动更新说明与 tag 防重复打包细则见 `product-decisions.md` §三。

### 4. 文档同步表（文档与代码进同一个提交，只改受影响的）

| 这次改了什么 | 同步哪些文档 |
|---|---|
| 用户看得见的入口、步骤、按钮文案、默认行为 | `docs/guide/user-guide.md` 对应章节；新术语补 §14.1；`docs/guide/tutorial.md` 写到了才改；改界面文字在这两份里搜旧说法 |
| 用户看得见的改动（含修好的用户可见问题） | `CHANGELOG.md` 未发布段 |
| 用户拍板、取舍、否决，或由此定下的规则 | `docs/conventions/product-decisions.md` 或对应领域 `conventions/*.md`，加 `docs/architecture.md` §10 一条 |
| 新增源文件，或文件的职责边界变了 | `docs/code-structure.md` 对应行 |
| 安装方式、功能总览变了 | `README.md` |
| 纯内部重构、按既有规则修 bug、只加测试 | 不改文档，写进提交信息 |

> 说明书写法：对「你」说话、保留小标题、专业克制（禁口语俚语）、术语以 `user-guide.md` §14.1 为准；改了 `user-guide.md` 的标题或段首加粗引导句后需跑 `cd src-tauri && cargo test project_assistant`（完整细则见 `product-decisions.md` §四）。

## 三、项目简介与构建运行

- **定位与身份**：**Mesa** 是面向研究生与科研人员的 AI 科研工作台（Tauri v2 + React/TS），底层统一管理十家 Agent CLI（Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build、Antigravity CLI）。**内部身份仍是 `ccode`**（bundle ID `com.ccode.dev`、`.ccode/`、`~/ccode/`、Codex provider `ccode`/`ccode-<短id>`），严禁把内部路径或安装身份跟着展示名改掉。
- **设计文档即规格**：改架构/适配逻辑前，在 `docs/architecture.md` 与 `docs/agent-integration-matrix.md` 检索相关小节——**勿凭印象写 env 变量名**。需要借鉴开源机制时先查 `.reference/`（`cc-switch` / `waveterm` / `vscode`）。
- **已确认的产品决策全文**：见 `docs/conventions/product-decisions.md` §一（含一等/维护级 CLI 分级、项目助手、综述回路、流程贯通、任务包、研讨、接力、核验记录、科研做图、项目体检、Agent Workspace、桌宠、手机助手、开源署名等，改相关功能前必查）。

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # Rust 不在默认 PATH，新 shell 先 export
npm run tauri:dev                      # 热更新开发窗口（Mesa Dev - 热更新，端口 17575）
npm run typecheck                      # 前端增量类型检查（tsc --noEmit，局部改动必跑）
npm run build                          # 前端完整构建（tsc + vite 生产打包）
npm test                               # 前端全量测试（node --test）
cd src-tauri && cargo build / cargo test
npm run tauri build                    # 打包
```

- **环境与验收锚点**：Node 22 + npm（无 pnpm）；Rust stable（crates 走 rsproxy）。dev 端口固定 **17575**（第二实例 `npm run tauri:dev:17576`，勿擅改端口，被占先报占用方）。**界面验收必须定位窗口标题「Mesa Dev - 热更新」（`com.ccode.dev.hmr`，连 17575）**，严禁拿 `/Applications/Mesa.app`、`target/release` 等旧打包当作验收依据；无法确认归属时停止并报「未验收」。
- **代码结构速览**（逐文件职责与红线 Grep `docs/code-structure.md`）：
  - `src/`：前端 React + TS + Tailwind v4（`pages/`、`components/`、领域纯逻辑 `.ts` + `tests/` 同名测试）
  - `src-tauri/src/`：Rust 后端（`agent_specs.rs`、`agents.rs` 与各领域模块）
  - `docs/`：`architecture.md`、`agent-integration-matrix.md`、`conventions/`

## 四、每次会话都必须遵守的通用红线

> 特定子系统的详细红线（Codex `config.toml`、gitignored 科研产物口径 C、CLI 旁路与金丝雀、`lit_records.py` / `quarto render`、非对话模型与出图、UI 测试 esbuild 桩与 JSDOM 断言等）已完整归档在 `docs/conventions/product-decisions.md` §二–§三，改到对应模块前必搜。

1. **密钥与脱敏**：密钥存 0600 `keys.json`，仅拉起瞬间注入子进程 env，绝不回显或进 shell；`NO_COLOR` 必须 `env_remove`，显式设 `TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Mesa`。会话文本出站前必须在 Rust 层脱敏（只作用于 DTO/导出副本，不改源文件；前端遮盖不是安全边界）。
2. **CLI 目录只读**：各 CLI 会话/配置目录一律只读（仅允许用户显式操作：设为全局默认、hooks 开关、会话删除/瘦身/导入、编辑配置文件等，白名单与备份口径见 `safety.md` / `product-decisions.md`）。用量历史 `usage_daily` 永久保留，禁整表清空。
3. **锁与主线程**：配置读改写持进程锁 + OS 文件锁，失败不得无锁继续；PTY 全局锁内禁阻塞写入；**会等待的 Tauri 命令必须 `async fn` + `spawn_blocking`**（同步命令会卡死所有终端输出）。
4. **三平台兼容与路径方言**：禁写平台特定路径，统一用 `crate::dirs` / `process::background_command` / `process::pty_command`（超时用 `kill_process_tree` + `join_with_timeout`）；后端跨来源路径比较一律用 `paths::same_path` / `path_within` / `path_key`（前端 `src/path-utils.ts`）；纯逻辑平台分支必须 `isWindows` 显式传参；unix 专属函数加 cfg 门控；平台专属 crate 放 `[target.'cfg(...)'.dependencies]`；测试禁墙钟硬断言、禁触系统 UI/回收站。
5. **二进制与 Python**：解析统一走 `agents::resolve_binary` / `resolve_binary_all`（禁裸 `which::which`）；Python 一律走 `dep_check::usable_python()`，Agent 跑 Python 走 `MESA_PYTHON`。
6. **序列化、前端边界与开源**：嵌套进 camelCase DTO 的结构体整体 `#[serde(rename_all = "camelCase")]`；前端不直接碰文件系统，全部经 Tauri command；UI 文案用中文，代码注释用中文且只在非显而易见处写；**改动依赖后必须跑 `npm run gen:notices`**（版权落款 `泽塔前沿科技（杭州）有限公司`）。

## 五、主题约定索引（改哪块就 Grep 对应文件）

| 领域 | 文件 | 覆盖内容 |
|---|---|---|
| 产品决策与子系统细则 | `docs/conventions/product-decisions.md` | **从 AGENTS.md 拆出的全部已确认产品决策、子系统实现红线、测试/CI/发版细则与说明书写法** |
| 安全与数据防护 | `docs/conventions/safety.md` | 密钥/脱敏、git 逐 hunk 验收、多阶段 Git、profile 验证、会话/配置写白名单、诊断包、MCP/技能分发、飞书通道 |
| 终端与工作台 | `docs/conventions/terminal.md` | PTY 通道与流控、会话标题、标签白名单、评审/冲突覆盖层、收件箱、关窗守卫、输入侧、沉浸阅读、聊天层旁路、async 命令 |
| 流水线与项目域 | `docs/conventions/pipeline.md` | 工作区生命周期、流水线/模板/任务包、项目助手接活、综述回路与流程贯通、研讨/接力、核验记录、定时雷达、项目体检、外部软件接口 |
| 编程 Git / GitHub | `docs/conventions/coding-git.md` | **改编程页 git 前必读**：工作树 vs 主仓、基准开工、远程身份、PR 环 |
| 多 Agent 工作台对象 | `docs/conventions/agent-workbench.md` | **改工作台/并行/无头/Runtime 前必读**：Project→Task→Run、并行三层、项目内协作、定时隔离 |
| 步骤工作面板 | `docs/conventions/step-panel.md` | **新增步骤/模板前必读**：七条硬规则、问题层级分配、文案与术语清单 |
| 主题与设计系统 | `docs/conventions/design-system.md` | 主题令牌、字体栈、线条语言、页面框架、步进器规格、活跃度热力图、已否决设计 |
| 各页界面规格 | `docs/conventions/codex-style-ui.md` | 应用外壳、灵动岛、各页布局与逐项核验清单 |
| Agent 绑定体系 | `docs/conventions/agent-binding.md` | **改启动配置解析前必读**：解析塔、槽位白名单、开工弹层、工作区三链 |
| 网关与绑定 | `docs/conventions/profiles.md` | **改配置/注入/设为全局/模型能力/托盘前必读**：网关×绑定拆层、求交器、模型配置约定、Codex/Grok/Claude 细则 |
| 普通目标评审冻结 | `docs/conventions/review-freeze.md` | **改普通目标开工/收尾/评审/采纳前必读**：基线哈希、冻结 payload、三向判定 |
| 开源与许可 | `docs/conventions/open-source.md` | 署名、厂商图标规则、`gen:notices`、反馈端点 |
| 本机环境与踩坑 | `docs/conventions/environment.md` | 网络镜像、Windows/macOS 平台踩坑、登录 shell 环境、`MESA_PYTHON`、第二实例 |
| 客户端接力 | `docs/design-client-handoff.md` | **改客户端打开前必读**：能力分档、预检模型、失败话术 |
| 代码地图 | `docs/code-structure.md` | 逐文件职责/红线/双端镜像（按文件名 Grep） |

## 六、路线图与当前待办

见 `docs/architecture.md`：§10 决策记录（按关键词检索）、§11 演进线（P0–P5）、§12 当前待办与发布前检查项。
