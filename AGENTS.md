# AGENTS.md

> **省力原则（2026-10-26 用户拍板：别让 Agent 做无用功）**：每次会话只需读本文件，其余文档**按需检索、不通读**。
> - `docs/architecture.md`（三千多行）、`docs/code-structure.md`、`docs/conventions/` 下的大文件一律按关键词 / 文件名 / 函数名
>   Grep，只读命中的小节。下文写「改动前必读」，指读这次改动相关的条目，不是整份文件。
> - architecture §10 是新在前的日志：用关键词搜，同一主题以最新一条为准，不顺着读。
> - 按改动范围决定读什么、跑什么、改哪些文档：只改一处文案不必为「保险」去翻规范；没命中「文档同步」表的文档不用打开核对。
> - 开发中验证用最小的命令（单个测试过滤、一次 grep、一次构建），提交前再按「git 提交」① 跑一次该跑的全量基线；已确认的事实不重复核对。
>
> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（硬约束、本机环境档案）或对应
> `docs/conventions/*.md` 主题文件，以及 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是
> 操作记录，这里只留"以后必须遵守什么"。§10 只记用户拍板、取舍、否决及由此定下的规则，写清拍板、理由和细则落在哪个文件即可，
> 细则本身写进 conventions；按既有规则修 bug、重构、补测试只写提交信息，不进 §10。本文件只放每次会话都要守的硬约束，
> 单一领域的细则放 conventions，这里留一行指针。
>
> **边走边改（2026-09-22 用户拍板）**：用户在走科研流程时的提问和反馈，默认是要改他正在用的那条流程（当前课题档案卡 + 模板/任务书/界面），不是要一段说明。先核对实际落盘和界面再改，改到这一步能接着用；回答里写清改了什么、在哪能看见。
>
> **动真实数据先干跑 + 未发布不养闲机器（2026-10-13 用户拍板）**：凡要写用户真实项目数据的功能（迁移/清理/批量改写一类），
> 交到用户手里点之前必须先在干跑环境或用户一个真实项目上完整执行一遍验证——静态审查代替不了执行（当日实证：迁移命令审查
> 全过，用户一点才暴露 git add 拒收被忽略文件）。应用未发布期间，只服务「假想老用户」的界面机器不留：用户数据量小就直接
> 替用户做掉并验证，机器删掉（当日实证：文献台账迁移命令+界面整体移除）；~~真到发布需要重建的，重建序列记在
> `docs/conventions/pipeline.md`「双台账·存量收口」~~（2026-10-26 拍板收窄：GitHub 上的 v0.1.0 只是测试版、没有外部老用户，
> 存量迁移不重建，见 architecture §12「发布前检查项」当日条；「双台账·存量收口」仅作历史序列存档），发布前检查项见 architecture §12。
>
> **文档同步（用户指令）**：文档和代码进同一个提交（2026-10-24 用户：「下次提交之前更新文档」），事后另补不算。
> **只改受影响的文档**（2026-10-26 收窄，取代「每次提交前把全部文档过一遍」）：
>
> | 这次改了什么 | 同步哪些文档 |
> |---|---|
> | 用户看得见的入口、步骤、按钮文案、默认行为 | `docs/guide/user-guide.md` 对应章节；新的用户可见术语补进 §14.1；`docs/guide/tutorial.md` 写到了才改；改了界面文字，在这两份文档里搜一遍旧说法 |
> | 用户看得见的改动（含修好的用户可见问题） | `CHANGELOG.md` 未发布段 |
> | 用户拍板、取舍、否决，或由此定下的以后要守的规则 | 本文件或对应 `docs/conventions/*.md`，加 architecture §10 一条 |
> | 新增源文件，或文件的职责边界变了 | `docs/code-structure.md` 对应行 |
> | 安装方式、功能总览变了 | `README.md` |
> | 纯内部重构、按既有规则修 bug、只加测试 | 不改文档，写进提交信息 |
>
> 说明书写法（2026-09-18 用户拍板，否决无小标题长文）：`user-guide.md` 是面向使用者的**产品说明书**，写给干活的人；对「你」说话；保留小标题（如「安装时可能碰到的唯一拦路虎（Mac）」）；每节尽量同一口气——解决什么问题、打开会看见什么、一步一步怎么点、怎样才算做成、常见卡在哪；内部词第一次出现用白话带过。不要功能清单，不要文首流水账，不要把步骤揉进没有小标题的长段落。白话不等于口语俚语——「找场子」「糊涂账」一类词不得出现，语气保持专业（2026-10-09 用户拍板）。**术语以说明书 §14.1「常用词对照」为准**（2026-10-20）：两份文档同一概念只用一个词；界面按钮原名照写并在首次出现时括号解释，不在文档里单方面改按钮名；界面文字改名后两份文档与 §14.1 同批改。文中 `【配图】` / `【配视频】` 是后补素材位，改用法时同步改说明。版本叙事写 `CHANGELOG.md`（发版本时更新）。

> **跨平台换行约定**：仓库文本文件统一以 LF 形式存储，规则见 `.gitattributes`。Windows 本地可保留
> `core.autocrlf=true`，但提交前不得把换行转换造成的全文件差异带入变更。

## 项目简介

Mesa 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是九个 Agent CLI 的统一控制台（启动器 + 配置中心 +
会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：AI 负责干活，Mesa 负责管活，人负责拍板。
展示名 **Mesa**；内部身份仍是 `ccode`（bundle ID `com.ccode.dev`、项目 `.ccode/`、`~/ccode/`、Codex provider `ccode`/`ccode-<短id>`）。禁止把内部路径/安装身份跟着展示名一起改。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build 管理多套 API 配置
（端点/密钥/模型），内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前，在 `docs/architecture.md`（总体设计）和 `docs/agent-integration-matrix.md`
（九个 CLI 的 env/配置/会话格式，源码级调研结论）里检索相关小节——**勿凭印象写 env 变量名**。

**参考实现（长期有效）**：`.reference/` 下三个开源项目浅克隆，设计新机制前（不是修 bug、改文案）先查有没有成熟方案可借鉴：

- `.reference/cc-switch`（Tauri2+React+SQLite）：provider 预设/一键导入、双向同步回写保护、本地代理与故障转移、原子写入、测速、托盘速切、导入导出
- `.reference/waveterm`（Electron+Go+SQLite）：block/workspace 对象模型与持久化、"named = saved" 留存语义、badge 注意力标记与 hooks 联动、滚动缓冲区序列化恢复、namespaced meta 键体系
- `.reference/vscode`（blobless 浅克隆）：Explorer 文件树、编辑器 tab 与 split、面板布局、终端标签列表；目录索引在 `src/vs/workbench/contrib/`

借鉴原则：学机制和取舍，不抄代码；冲突时以 `docs/architecture.md` 为准（不走本地代理主线、会话解析坚持只读）。镜像可随时 `git -C .reference/<repo> pull` 更新。

**已确认的产品决策**（用户拍板，勿擅自更改；细则在所指文件里）：

- 应用展示名 **Mesa**（内部身份仍 `ccode`，见上）；九个 agent 全部支持（CodeBuddy Code、Cursor CLI、Grok Build 见 matrix §7/§8/§9；grok：MCP 只读不分发、技能强制 copy；「设为全局默认」2026-09-01 起支持，写 ~/.grok/config.toml）
- 配置切换**双模式**：默认启动注入环境变量（零污染），另提供「设为全局默认」（写配置文件，先备份）
- 终端为内嵌形态，且**与结构化会话视图联动**（同一会话双栏观看）
- **会话标题**（2026-09-10）：展示格式 `MMDD|类型|主题`；自动起名只写 Mesa 侧 `custom_title`（`title_source=auto`），不写回 CLI 源文件、不覆盖人手改的标题（`title_source=user`）；续链合并为一条；设置里可关。细则见 terminal.md（搜 `MMDD|类型|主题`）
- 项目列表**从各 agent 历史会话自动聚合并分类**，辅以手动添加
- token/费用统计随 P3 顺带做，不提前
- **三平台（macOS/Windows/Linux）同步**支持，功能不得以平台为由裁剪
- **Agent Workspace（v3.221 / v3.235）**：以 Project 为家。人负责目标，系统给环境（文件地图、规则、上下文）和验收门；Agent 自己规划。CLI 是第一种 Runtime。用户不面对 Run。并行只来自人声明或模板，禁止自动拆任务 / 智能路由。科研/编程两套 worktree 库不合并。工作台「正在进行」只列交互活；关标签后按 `runId` 找回。定时隔离产物经评审才进主仓。改工作台/目标/验收前必读 `docs/conventions/agent-workbench.md`
- **开源与许可（2026-10-12）**：Apache-2.0；**版权落款 `泽塔前沿科技（杭州）有限公司`**（七处署名）；商业中转预设不进开源默认表；
  厂商图标只给官方域名，第三方中转站一律首字占位；**改动依赖后必须 `npm run gen:notices`**；对外发布修改版须换名换图标（`TRADEMARKS.md`）。
  细则 `docs/conventions/open-source.md`
- **用量页活跃度热力图（2026-10-12）**：色阶锚 `--color-cta`；着色/活跃/streak 恒只算非 internal 用量，「显示内部活动」开关不改色不改统计。
  细则 design-system.md「活跃度热力图」
- **定时雷达（2026-10-13）**：雷达文献＝项目内日常积累，不进科研流程——绝不写 `papers/included.md`、`notes/index.json`、`references.bib`；
  雷达台账全 gitignored、不影响合并；**精读接续铁律**：某篇已有笔记时在原笔记上续写，「标注」「译段」「我的想法」与用户手写内容原样保留、
  不另起平行笔记。细则 pipeline.md「评审与采纳口径」「双台账」
- **设为全局写入规则（2026-10-30）**：写到 CLI 实际读的目录（认 `CODEX_HOME` 等搬迁变量）、与启动注入同源、只管自己写的键且先清再写、
  写前说清会被什么盖掉、用户能改的写用户层、官方切回只撤 Mesa 写的、被引用的文件不随连接删、密钥能引用就不写明文、金丝雀「全局配置」层每天复核。
  改任一家写计划前读 profiles.md §12 开头九条
- **从手机添加（2026-10-20）**：手机→桌面**单向**、**Mesa 开着才收**、只走局域网；配对永远要人点开始；收到的先进暂存区，**人点了才进项目**
  且只走已有入口。改这块前读 `docs/design-phone-drop.md` 与 safety.md 同名条

## 构建与运行

> **审计收口硬约束（2026-09-08）**：配置读改写持进程锁＋OS 文件锁，失败不得无锁继续；拆层迁移以 pending 恢复日志最终删除为完成，私有临时文件创建即 0600。PTY 全局锁内禁止阻塞写入，诊断输出不得同步落库卡回显。新建/恢复都兑现 discuss 权限，缺能力拒绝；原生退出负责进程回收。生产 CSP 不得因调试置空，Vite 脚本显式选择 `vite.config.ts`。细则与未验收范围见 safety.md / terminal.md / `docs/audit-remediation.md`。

```bash
# Rust 不在默认 PATH，每个新 shell 都要先 export
export PATH="$HOME/.cargo/bin:$PATH"

npm run tauri:dev      # 开发（独立 Mesa Dev 窗口；前端 HMR + Rust 改动自动重启）
npm run build          # 前端构建（tsc + vite）
npm test               # 前端测试（node --test，CI test job 同步执行）
cd src-tauri && cargo build / cargo test
npm run tauri build    # 打包
```

环境：Node 22 + npm（无 pnpm）；Rust stable（minimal profile）；crates 走 rsproxy 镜像（`~/.cargo/config.toml`）。

开发预览必须使用 `npm run tauri:dev`：独立产品名 **Mesa Dev**、窗口标题 **Mesa Dev - 热更新**、bundle ID
`com.ccode.dev.hmr`（`src-tauri/tauri.dev.conf.json`）。界面验证必须按该窗口标题或明确 `.app` 绝对路径定位，禁止用模糊应用名 `Mesa` / 旧名 `Ccode`。
**界面核验不得混入旧打包前端**：`/Applications/Ccode.app`、`/Applications/Mesa.app`、`target/release`、普通 `com.ccode.dev` 与历史 `target/debug/bundle`
均不可作为验收依据；只能验收 `tauri dev --config src-tauri/tauri.dev.conf.json` 启动、连接 17575 的热更新窗口。无法唯一确认窗口归属时停止界面操作，改报“未验收”，不得拿旧窗口截图或状态代替。

## 本机环境档案（每会话必读的短条目）

- **平台/网络踩坑全录见 `docs/conventions/environment.md`**（**涉网络下载、装依赖、Windows/macOS 平台行为、
  构建异常、开第二开发实例时检索**）：crates 走 rsproxy、brew bottle 走南大 ghcr 代理、密钥弃钥匙串改 0600
  `keys.json`、Windows conhost 闪窗与 npm .cmd shim、macOS CLT stub 与 Xcode 许可、PDF 预览白屏等。
- **dev 端口固定 17575**（勿改回 1420；agent 不得自行改端口或另起配置外实例，被占先报占用方交用户处理）。
  第二实例走 `npm run tauri:dev:17576`，验收三锚点 = 仓库路径 + 窗口标题后缀 + devUrl 端口（细则见 environment.md）。
- **git 提交与单人开发流程（2026-09-22 定稿）**：日常直接在 main 上开发，三条纪律——
  ① **一个主题一个提交**，提交时**改到的那一侧**基线全绿（2026-10-26 用户拍板，取代「每次三样全跑」）：
  只改文档不跑；只改 Rust 跑 `cd src-tauri && cargo test`（全量，不能只跑改到的模块）；只改前端跑 `npm test` + `npm run build`；
  两侧都改，或动了两侧共用的东西（共读的 `tests/fixtures/` 样例、Tauri 命令名与参数、DTO 字段名、双端镜像逻辑）三样全跑；
  拿不准算哪种就全跑。CI 每次 push 在两平台三样全跑兜底，本地漏判的代价是 main 红，红了当次处理。
  禁止攒多主题「一系列修复」式大杂烩提交（提交太大 `git bisect` 定位不了回退）。
  **做完一处就同步文档并提交**（2026-10-26 用户：「以后做完一个地方就更新文档提交」）：一个问题 / 一处改动做完、
  验过，当场按「文档同步」表改受影响的文档、跑该跑的基线、提交，不攒到用户回头说「提交」；用户说了先别提交的照办。
  工作区里有别的会话的改动时只提自己这一处（按片段放进暂存区），别人的不动。**`node --test` 只剥类型
  不做类型检查**，tsc 错误只有 `npm run build` 抓得住，改了前端提交前必须跑（2026-09-22 实证：三处 tsc 错误
  带病进了 main，本地测试全绿）。
  ② 几天的大功能或实验性改动开分支（`git switch -c feat/...`），做完 `git merge --no-ff` 回 main；
  已 push 的历史禁止 rebase/amend 改写。单晚小修、文档直接 main。
  ③ **测试基线必须保持全绿**：存量失败不修，「红绿」就没有信号价值，新失败也分不清是不是自己引入的
  （2026-09-22 实证：3 个 UI 测试存量失败把 CI 挡在 npm test 一步，tsc 报错与 objc2 跨平台编译失败
  两类更深的问题被挡住看不到）。
- **CI 纪律（2026-09-22 修订，取代旧规「常规提交加 [skip ci]，里程碑提交才跑 CI」）**：push 到 main 即触发
  test job（npm test + cargo test + npm run build；当前矩阵 macOS + Windows——**Linux 本版本未开发，
  2026-09-22 移出测试矩阵**，恢复开发时把 ubuntu-latest 加回 build.yml，平台差异挡过主线三次），
  **保持绿是硬要求**，红了当次推送就要处理；`[skip ci]` 只用于纯文档等不可能影响构建的提交。
  平台专属 crate（如 objc2、windows-sys）必须放 `[target.'cfg(...)'.dependencies]` 段——主
  `[dependencies]` 里的平台专属依赖会让别的平台直接编译失败（2026-09-22 objc2 实证）。
  发版打包仍走 tag push（package job 只认 tag；Linux 2026-09-22 起同样移出发版矩阵——
  不再出新安装包，已装的 Linux 用户收不到更新，恢复开发时把 ubuntu-latest 加回两个矩阵）。
- **UI 组件测试打包口径（2026-09-22）**：tests 用 esbuild 内联打包 .tsx 组件的（research-*-ui.test.ts 模式），
  组件图拉进 monaco css、Vite `?worker`/`?url` 导入、pdfjs 时按桩处理：`.css` 配 empty loader（css 空了
  其中字体 url 不再解析）、query 后缀路径桩成惰性 data: URL **字符串**（pdfjs 校验 workerSrc 必须是字符串）、
  JSDOM globals 补空壳 `DOMMatrix`（pdfjs 模块初始化顶层 `new DOMMatrix()`，`pdf.mjs` 的 SCALE_MATRIX
  常量）。新组件测试照抄这三个文件的口径，别让打包问题冒充组件 bug。
- **git 分支纪律**：未经用户明确指令，禁止 checkout/switch/merge/rebase/stash/删分支等任何改动 HEAD 或分支指向的操作；
  开工先 `git branch --show-current` 确认在用户指定的分支上，不符就停下报告，不自行切换；任务收尾报告分支名 + `git status` 结果。
- **git 推送走 SSH:443 + repo deploy key**；发版推 tag 后先用 `gh run list --workflow build.yml` 确认是否已产生该 tag 的 push run，已触发则只保留该 run；30 秒内未触发才执行 `gh api repos/Zeta-Techs/mesa/actions/workflows/build.yml/dispatches -f ref=<tag>`。禁止让 tag push 与 workflow_dispatch 两个打包 run 并行写同一 Release。workflow 已配 `permissions: contents: write`（tauri-action 建 Release 草稿必需）。**仓库在公司组织 `Zeta-Techs/mesa`**（2026-10-27 由个人仓库 `hongtongzhou-design/ccode` 转入）：仓库 owner 与 tauri.conf 升级端点绑定，再转移时本命令、updater endpoint、README 与代码里的仓库链接必须同步改（`git grep` 旧地址）。**个人账号下永远不要再建名为 `ccode` 的仓库**——旧地址靠 GitHub 自动跳转，同名新仓库会截断跳转。
- **CI 测试**：禁墙钟时序硬断言（runner 调度延迟不可控；只留内容语义断言 + 防挂死宽松兜底）；unix 专属语义（symlink/PTY/脚本）测试加 `#[cfg(unix)]`；路径断言用 `Path::ends_with`（Windows `\`）；**测试禁触系统 UI/回收站**——`trash` 等走 Finder AppleScript 的调用在测试态必须经隔离缝直删（projects.rs `trash_to_recycle_bin` 先例：测试驱动 Finder 会与用户桌面互抢并偶发 -47，purge 组 51.7s→0.06s 实证）。

## 代码结构

**逐文件职责地图见 `docs/code-structure.md`**（含每个源文件的职责边界、红线注释与双端镜像口径）——
**改源文件前在地图里 Grep 该文件名，读它的条目**（不通读地图）；新增文件同步补进地图（一行职责，只在非显而易见处写注释）。顶层速览：

```
src/             前端 React + TS + Tailwind v4：pages/（侧栏九页）+ components/（视图/弹层）+
                 领域纯逻辑模块（一个领域一个 .ts，配 tests/ 同名测试）
src-tauri/src/   Rust 后端：agent_specs.rs（九 CLI 中央规格表）+ agents.rs（适配分发入口）+
                 各领域模块（profiles / projects / workspaces / sessions / usage / scheduler / …）
docs/            architecture.md（总体设计 + §10 决策记录 + §12 当前待办）
                 conventions/（主题细则，见下索引）+ agent-integration-matrix.md（九 CLI 源码级调研）
```

## 关键约定

以下硬约束**任何会话都必须遵守**；各领域的细则（评审覆盖层交互、流水线开步参数、步进器视觉规格、MCP 字段映射等）
在 `docs/conventions/`，改哪块就在对应文件里检索相关条目，日常会话不必加载。

- **密钥绝不回显/进 shell**：存 0600 `keys.json`（键=网关 id），只在拉起瞬间注入子进程 env；绑定/网关 JSON 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Mesa` 必须显式设置。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。
- **gitignored 科研产物最终落点是项目根，但分两类走法**（2026-09-09 口径 C）：文献 PDF 与人工导入属**原始资料**，直写项目根 `papers/`；清洗后数据、实验结果、渲染成品等 **Agent 派生产物**写工作区产物目录或 `output/`（不进 git），评审时经 `workspace_review_deliverables` 冻结非 Git 文件，合并只由 `apply_delivery_review` 带回所审副本（同名冲突点名交人、保护路径跳过；人在评审页逐个勾掉的不带回；有未接收产物不得归档——人勾掉且仍是那一版的除外，见 pipeline.md「逐个勾掉不带回」）。派生产物直写项目根 = 未验收产物。TASK.md 必须给出项目根绝对路径（读提货单、写 papers/）。
- **Codex 全局写入不碰 `~/.codex/auth.json`**（v3.249 / v3.250）：「设为全局」与客户端接力的渠道补写（`register_codex_client_provider_named`）都只写 `config.toml` 的 provider 块，认证用 `experimental_bearer_token`（ChatGPT 自带 Codex 认这个字段）。禁止写 `http_headers`（MCP 字段，写在 provider 上客户端加载失败报 Model provider not found）。禁止退回 `requires_openai_auth=true` + 改 auth.json。API 连接「设为全局」一律写共用渠道名 `custom`（2026-10-28，与 cc-switch 同名）；官方账号不进 `custom`，撤 `model_provider` 回内置 openai（中转历史接不到官方，见 profiles.md §12）。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：设为全局默认、hooks 精确注意力开关（2026-10-20 起只剩 Gemini / Kimi / Grok；
  其余五家启动时注入，以前写过的启动时收回）、Gemini 认证方式一键设成 API Key（只改这一项、先备份，2026-10-27）、会话删除、工作树文件删除（走系统回收站）、会话导入、内部对话保留期清理（只删 Mesa 自己的后台对话，
  `internal_sessions.rs`）、会话瘦身（仅 Claude Code，写前完整备份，`session_slim.rs`）。每类的备份 / 白名单口径见 safety.md。
- **用量历史永久保留（2026-10-17 用户拍板）**：会话文件消失（CLI 自己清理 / 内部对话清理）不得删 `usage_daily` 行，
  重建只撤 `seen:` 标记；只有用户在 Mesa 亲手删除对话才 `forget_session_usage`。用量表版本升级**禁止整表清空**，
  只清有 `seen:` 标记、能从文件重抽的行（不落盘调用的 `ephemeral-*` 行与已消失会话的行重抽不回来）。
- **一次性内部调用不落盘**：`ai_prompt_impl` 对 Claude Code 用 `-p --output-format json --no-session-persistence`、
  Codex 用 `exec --ephemeral --json`，花费从输出直接记账（`record_ephemeral_usage`）；定时任务等事后要回看的无头运行照旧落盘。
- **聊天层取数（2026-10-20，`chat_channel.rs`）**：优先 CLI 自带的结构化旁路，其次会话文件，最后读屏；旁路**不写用户配置**
  （只用启动参数 / 环境变量 / Mesa 目录下的临时文件），起不来照旧启动；hook 只记录、不阻塞、不替用户决定，审批只在用户点按钮后
  经 CLI 官方通道回；口令 / 令牌只经环境变量。改任一家旁路或升级 CLI 前先跑 `scripts/e2e-model-routing/README.md`「聊天层结构化旁路」
  两层核对。各家走法（Codex app-server、OpenCode 服务、OSC 7501 程序状态及其 Windows 不接）见 terminal.md / safety.md 同名条、
  matrix §14、`docs/design-chat-structured-channels.md`。
- **CLI 金丝雀（2026-10-21）**：`.github/workflows/cli-canary.yml` 每天装最新版九家 CLI 比指纹；红了是 CLI 变了、不是 Mesa 回退，不挡主线 CI。
  适配（或判定无需适配）后在**同一平台**跑 `--accept`，把新指纹连同改动一起提交；基线 `version` 随包进 Mesa（`src/cli-verified.ts`），
  CI 会把只前进了版本的基线自动提交回 main，本地推送前先 pull。维护流程见 `docs/agent-skills/mesa-cli-canary/SKILL.md` 与
  `scripts/cli-canary/README.md`；**仓库维护技能放 `docs/agent-skills/`，不进 `src-tauri/resources/skills/`**（那里随应用分发给用户）。
- **非对话模型与出图（2026-10-23）**：出图 / 视频 / 向量等模型按名分类（`image_gen.rs` ↔ `src/model-kinds.ts` 镜像，共读
  `tests/fixtures/model-kinds.json`），不得成为 Agent 对话模型（启动闸 `agents::validate_launch_compatibility`）。出图模型编辑处只在连接页。
  Agent 经随包 `mesa_helper image` 出图，密钥由 helper 自取、不进 Agent env，PTY 只注入 `MESA_IMAGE_TOOL`；找随包 helper 一律走
  `image_gen::find_bundled_helper`。细则 profiles.md / safety.md 同名条。
- **子进程环境来自登录 shell（2026-10-27）**：从访达打开时 `shell_env::import_login_shell_env` 在起线程前读一次 `$SHELL -i -l -c` 的环境，
  所有子进程继承；**API 密钥 / 端点类变量不从 shell 带入**（由 Mesa 连接配置注入）。改过滤表或启动顺序前读 environment.md 同名条。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底；新增 CLI/工具调用点一律
  用它，禁直接 `which::which` 或裸名 spawn（平台候选目录清单 = `agent_specs.rs::binary_candidate_dirs`，`agents.rs` 只是调用方）。
  PATH 上第一个可能是占位程序时（Windows 应用商店的 `python`、macOS CLT 没装时的 `/usr/bin/python3`）改用
  `agents::resolve_binary_all` 列全部候选、逐个试跑，拿「能跑」的那个（2026-10-19，见 dep_check `usable_python`）。
  **Python 一律走 `dep_check::usable_python()`**，禁 `resolve_binary("python3")`：python.org 的 Windows 安装包只有
  `python.exe`，`python3` 在 Windows 上永远先命中应用商店占位。给 Agent 的指令 / 技能里写 `python3` 时同时注明
  「Windows 上改用 `python`」。**Agent 起的 Python（PTY 子进程与无头运行）在 Windows 由 `process::agent_python_io_env`
  补 `PYTHONIOENCODING=utf-8`，禁补 `PYTHONUTF8`**（它连 `open()` 默认编码一起改）。Agent 加 `-I` / `-E` 时该变量失效
  （中文系统回落 GBK），Windows 任务书固定带「本机 Python（Windows）」节提示改加 `-X utf8`（2026-10-22，`task-md.ts`）。
- **检索 / 精读的题录只经 `lit-search/scripts/lit_records.py` 从 `papers/included.json` 出**（2026-10-22）：included.md、to-fetch.md、
  两份 RIS、references.bib 都是它生成，简报与技能不得再让 Agent 手写或自写补字段脚本；RIS 拼法与 `screening-review.ts risBody`
  双端镜像（`tests/lit-records.test.ts` 逐条比对），改一边两边同改；「待补」「待核」「无期号」不得进任何 RIS / 文献库字段（「无期号」= Crossref 有卷没期，不是缺口，2026-10-23）。
- **`quarto render` 命令（模板 run 脚本与技能）统一 `--output-dir ../output`、不带 `--output`**（2026-10-21 Windows 实测：写 `output`
  落进 `manuscript/output/` 且后一次渲染清掉前一次）；项目根不放 `_quarto.yml`；存量项目的 run 命令存在各自 `.ccode/project.toml`，
  改模板不会自动更新，要手工处理。PDF 走 xelatex 时 header 必须带 ActualText 开关（`manuscript_font.py` 写），否则分号文本层变 U+037E。
- **发版版本号三处同步**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 的 `version` 必须与
  git tag `vX.Y.Z` 的 `X.Y.Z` 一致（CI package job 会拦）。Tauri updater 只比较 `tauri.conf.json` 版本与
  `latest.json`，不认 git tag / architecture 决策号；不 bump 则已安装用户永远看不到「可更新」。内部决策记录
  （v3.x）不是应用版本。有可用更新时提示走收件箱 `update:`（不造顶部横幅、侧栏不挂徽标），设置页「更新」分区
  是安装入口。
- **发版前刷新随包模型能力库（2026-10-28）**：`npm run gen:model-db`（连不上 models.dev 时带 `HTTPS_PROXY`），把 `src-tauri/data/model-db-snapshot.json` 随版本提交；细则 profiles.md「能力库与价目怎么认模型」。
- **更新说明来自 CHANGELOG（2026-10-19）**：用户在应用里看到的「更新说明」是 `latest.json` 的 `notes`，打包时由 CI 取自 `CHANGELOG.md`
  （`scripts/release-notes.mjs`，优先 `## v<版本>` 段、其次 `## 未发布` 段，都空则 CI 失败）。**发版前必须先把本版本的用户可见改动写进
  CHANGELOG 对应段**；事后改 GitHub Release 草稿正文不会同步进 `latest.json`，用户仍看不到。
- **嵌套进 camelCase DTO 的结构体必须整体 `#[serde(rename_all = "camelCase")]`**（2026-10-03 实证：`RunRecord` 以蛇形
  `isolation_path` 出线、前端 `isolationPath` 恒 undefined，雷达「去评审」从未出现）。与磁盘共用一个结构体时加蛇形
  `alias` 兼容读旧档；单词字段天然一致不算，逐字段 rename 只修一个字段是这类 bug 的温床——新增多词字段时整结构体统一。
- **路径比较与文件名统一走方言层**（2026-08-29 Windows 协作批确立）：后端跨来源路径比较一律 `paths::same_path` /
  `path_within` / `path_key`（禁字符串 == / starts_with / 拼 `/` 前缀），落盘与显示先 `strip_verbatim`；前端同口径在
  `src/path-utils.ts`。新建/重命名文件（夹）名走 `paths::validate_fs_name`（报错），自动生成走 `sanitize_fs_name`
  （清洗）——全平台同一套规则，护跨机同步。纯逻辑模块的平台分支（如 escapeShellPath/pickQuickChatSessions）必须
  `isWindows` 显式传参，禁模块内隐式读平台（否则单测随宿主机器变）。
- 三平台兼容：禁写平台特定路径，用 `crate::dirs`（系统目录唯一入口，Windows 新用户沙盒靠它换目录）/`keyring`/`portable-pty` 的抽象；unix 专属函数加
  `#[cfg_attr(not(any(unix, test)), allow(dead_code))]` 或 cfg 门控（Windows 编译不过就是漏了）；起子进程统一
  `process::background_command`（后台）/ `process::pty_command`（PTY），超时终止用 `kill_process_tree` +
  `join_with_timeout`，禁裸 kill + 无限 join。子进程不继承 Mesa 自己的 `PWD`（后台删掉、PTY 设成工作目录；
  `opencode run` 按 PWD 取目录，2026-10-20 实证写错地方）。前端往 shell 写 `cd` 走 `pty_cd`（按标签的 shell 方言），不自己拼。
- **客户端接力（2026-10-18）**：对话 / 项目交给 agent 自己的 GUI 客户端打开，一律走 `client_open.rs`，**前端不得自己拼深链**；
  判断全在发深链之前（只读预检），读不到的不假装知道，会话 id / 写进 TOML 的块名后端校验后才拼，按钮文案如实写能打开到哪一层，没装客户端就不显示。
  改这块或新增客户端前读 `docs/design-client-handoff.md`。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；PTY 输出走前端交给 `pty_subscribe` 的通道（带流控确认 `pty_ack`），
  退出与后台信号走 `pty-exit-<id>` / `pty-signal-<id>` 事件（terminal.md「终端输出走通道 + 流控」）。
- **会等待的 Tauri 命令必须 async（2026-10-21）**：不带 `async` 的命令跑在主线程上，终端输出也要排主线程的队——同步命令里
  等子进程 / 外部应用 / 端口 / 回收站 / 目录树 / 评审快照，等待期间所有终端停住。这类命令写 `async fn` + `spawn_blocking`；
  细则与已挪清单见 terminal.md「会等待的命令不占主线程」。

### 主题约定索引（改哪块，就在对应文件里检索相关条目）

| 领域 | 文件 | 覆盖内容 |
|---|---|---|
| 安全与数据防护 | `docs/conventions/safety.md` | 密钥/脱敏细节、git 提交与逐 hunk 验收、多阶段 Git、profile 三层验证、会话/配置写操作口径、诊断包、MCP 分发与技能导入导出、CLI 更新、PDF/笔记白名单 |
| 终端与工作台 | `docs/conventions/terminal.md` | PTY 回落 shell、会话标题、标签持久化白名单、评审/冲突覆盖层、改动面板、收件箱与注意力规则、键盘流、分屏、关窗守卫、WebGL 探针、输入侧（图片粘贴/文件拖入/右键菜单/链接点击）、沉浸阅读区、聊天层旁路 |
| 流水线与项目域 | `docs/conventions/pipeline.md` | 工作区创建/漂移/归档/删除、流水线开步/模板/编辑器、接力与提炼接力、任务卡、人工事项与讨论种子、agent 人工请求（help-wanted）、收件箱分类胶囊、示例课题、白话双层、定时雷达与双台账 |
| 编程 Git / GitHub | `docs/conventions/coding-git.md` | **改编程页 git 前必读**：工作树 vs 主仓 vs GitHub Desktop、从基准开工、远程身份、PR 环、不做任意 git 命令框 |
| 多 Agent 工作台对象 | `docs/conventions/agent-workbench.md` | **改工作台/并行/无头/Runtime 前必读（v3.221 定稿；第 0–3 期核心路径已落地）**：Project→Task→Run、编程车道、RuntimeKind、禁止自动拆工；定时任务默认隔离 worktree；非 Git 项目失败 |
| 步骤工作面板 | `docs/conventions/step-panel.md` | **新增步骤/模板前必读**：七条硬规则（顺序即语义、空节点不出现、同一事实只说一次、孤立按钮、主路径唯一、显式决策契约门控、角色标注）、问题该在什么时刻与层级出现（项目层/决策项/按需问/种子/人工事项五选一）、文案与术语、新增模板检查清单 |
| 主题与设计系统 | `docs/conventions/design-system.md` | 主题令牌、字体栈、线条语言、控件密度、页面框架、对话页三栏、步进器规格、活跃度热力图、已否决设计 |
| 各页界面规格 | `docs/conventions/codex-style-ui.md` | 应用外壳与灵动岛、交互语法、工作台/项目/运行/对话/连接/技能/MCP/用量/设置各页布局、逐项核验清单 |
| Agent 绑定体系 | `docs/conventions/agent-binding.md` | **改任何「谁用什么配置启动」前必读（2026-10-15 定稿）**：解析塔（实体绑定>用途槽位>项目默认>记忆>全局）、槽位白名单（reader/discuss/step:）、开工弹层两态勾选、kickoffLast 拆键、工作区三链 workspaceLaunchChain、商量类不吃步骤绑定 |
| 网关与绑定（配置模型层） | `docs/conventions/profiles.md` | **改配置/注入/设为全局/模型能力/托盘前必读（已落地）**：网关×绑定拆层、binding id 复用、provider 派生名、relay 缓存键、求交器、体检与通道表不对称、迁移合并、模型配置约定（Claude --settings、Grok fail-closed、Codex 端点分槽、思考档注入优先级）、非对话模型与出图模型 |
| 普通目标评审冻结 | `docs/conventions/review-freeze.md` | **改普通目标开工/收尾/评审/采纳前必读（2026-09-09 落地）**：开工基线哈希、收尾冻结 payload、采纳三向判定与删除/大文件/旧 Run 口径 |
| 开源与许可 | `docs/conventions/open-source.md` | **改许可文件、署名、服务商图标、预设表、依赖、「关于」页或帮助菜单前必读**：七处署名、图标署名与使用范围、gen:notices、反馈端点 |
| 本机环境与踩坑 | `docs/conventions/environment.md` | 网络镜像、跨平台行为（Windows conhost/npm shim、macOS CLT/Xcode、PDF 白屏）、钥匙串、双 clone 第二实例、开发态随包 helper；涉网/装依赖/平台问题时检索 |
| 客户端接力 | `docs/design-client-handoff.md` | **改「在 Codex 客户端 / Claude 桌面版打开」或新增客户端前必读**：能力分档、预检模型、失败话术表、分期与真机点验清单；调研事实见 matrix §13 |
| 代码地图 | `docs/code-structure.md` | 每个源文件的职责/红线注释/双端镜像口径；改源文件前 Grep 该文件名读条目，新增文件补地图 |

## 路线图与当前待办

见 `docs/architecture.md`：§11 演进线（P0–P5 定稿）、§12 当前待办与批次状态（滚动维护）、§10 决策记录（历次拍板全文，按关键词检索）。
