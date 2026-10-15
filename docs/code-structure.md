# 代码地图（源码逐文件注释）

> 2026-09-22 自 AGENTS.md「代码结构」整节迁入（原文未改）。
> **改任何源文件前先查它的条目**——条目里是职责边界、红线和双端镜像口径，不是目录装修。
> 迁移新文件进本图时保持在 AGENTS.md 时代的老规矩：一行职责 + 只在非显而易见处写注释。


```
docs/                        # 架构方案 + 九 CLI 适配参考（规格）
  conventions/               # 主题化约定细则（改动对应领域前必读，见「关键约定」索引）
src/                         # 前端 React + TS + Tailwind v4（vite 插件接入）
  pages/                     # 侧栏九页：工作台▣ 项目⛁（workspaces，v3.92 起 UI 页名「项目」） 运行⌨（terminal） 对话◔ 连接⇄（profiles） 技能✦ MCP⌗ 用量◫（stats） 设置⛭
                             # 定时任务不是侧栏页（2026-09-13 用户移除）：只是项目「定时任务」页签；
                             #   页切快捷键（hotkeys.ts PAGE_HOTKEY_DEFS）、设置页「启动时进入」与 settings.rs KNOWN_PAGES 同为九页清单，
                             #   全局 page id schedules 仅作旧值重定向（App.tsx 转项目定时任务页签），SchedulesPage.tsx 已删
  components/                # WorkspaceReviewView、PipelineEditor（含「＋ 从模板追加」）、ProjectGroup/ProjectRail、ArtifactChecklist（文本类产物就地预览层；pdf/docx/表格/图同页弹层 +
                             # md 笔记「⛶ 沉浸阅读」入口（v3.98：pdf_for_note 配对后发 readerReq 带 notePath 进阅读区）+
                             # ⠿ 拖出手柄经 tauri-plugin-drag 做 OS 级文件拖出——WebView HTML5 拖拽出不了窗口）、TaskCardsSection、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/XlsxPreview/ImagePreview、ImagePairView、GitPanel、HandoffPicker/DigestPicker、
                             #   PDF 字节模块级 LRU 缓存（loadPdfBytes，上限 8 份）：预览⇄阅读区重挂载不再重走
                             #   read_pdf_bytes IPC+atob+解析三程，骨架期只剩 pdf.js 解析一程）、
                             # KickoffConfirmDialog（开工确认弹层：TASK.md 预览/编辑（草稿优先）+ 旧简报并入兜底 + 技能区（含 MCP 归处标记）+ 人工事项区 + 主仓提醒 +
                             # 上一步收尾软门：紧邻上一步非可选 after 事项未勾 → 「确认开始」二击变「仍要开工」才开，只确认不阻断）+
                             # 未存进历史软门（2026-09-20）：未提交改动与本步 inputs 相交（相交判定 src/kickoff-dirty-gate.ts）→ 列文件 +
                             # 就地「存进历史」（git_commit 只提交命中子集）/二击开工；不相交仍只是主仓提醒行（想法期实验改动留在主仓合法））、
                             # StepSkillsChips（步骤推荐技能 chip 区：只读/可编辑两态 + 产物冲突/跨步骤链路 ⚠ 警告行）、
                             # HumanTasksList（人工事项清单 + useHumanTasks 共享逻辑；待确认清完且未手动取消才自动勾）、StepFlow（步骤内协同流程线；付费墙行已登录显示「已登录」，未登录才是「登录学校账号」；拖进待获取清单按文件名、DOI 和 PDF 内标题对条目）、
                             # ScheduleSection（定时任务：有流程在项目设置抽屉；无流程主区雷达下；编程/办公右侧会话栏；
                             #   onSchedulesChanged = 任务集变更回调，定时任务页里喂 ProjectSchedulesView 的版本号桥）、
                             # LitWatchCard（「◔ 文献雷达」卡片：近 8 周趋势（全部缺巡检日时可按巡检日补记）+
                             #   命中固定两行（标题一行；第二行摘要+徽章+日期+加入积累，解读/来源/⋯ 悬停才现；无获取全文）+
                             #   书标三态：加入积累只写账不跳转；已积累点击＝展开「积累 N」抽屉定位该篇（移出只走抽屉 ✕）；
                             #   仅在正典（不在积累账）点击＝打开已存全文或说明去处——精读/笔记/全文入口统一在抽屉，
                             #   「精读」有笔记（list_paper_notes×noteLinkForPaper）显「继续精读」+
                             #   待人工下载：官网/等待收货+取消/关联/✓已存/打开 papers/ +
                             #   新命中默认两行对齐精读清单密度（摘要点开才见）+
                             #   期刊徽章（IF/中科院分区/TOP，数据源 journal_metrics.rs）+ 新命中按日期/按关键词分组切换 +
                             #   卡头期刊指标表入口常驻（未装=↓下载 / 已装=↻重下即更新）+ 卡头「筛选」弹层
                             #   （litWatchFilter：IF/分区/TOP 三条件，被筛掉条目「查看全部」临时态），唯一挂载点 ProjectSchedulesView（项目「定时任务」页签，仅科研工作方式渲染）；
                             #   空态入口只认有任务的卡（2026-10-12）：没订阅时若有雷达巡检出「还没订阅读+订阅关键词」，
                             #   连雷达巡检都没有则整块不渲染——订阅无任务不跑，定时任务页只留「＋ 定时巡检」主路；
                             #   schedulesVersion prop = 同页任务列表增删改的桥（新建/删除不发 scheduler-run-done，靠它重拉））、
                             # ReaderTlFloat（译文「译」悬浮球：可拖动（位置记 readerTlBall），点球在球旁展开译文卡、
                             #   × 收回球，新翻译落地自动展开；钉住档与右栏收起兜底档的载体）、
                             # ReaderOverlay（沉浸阅读区全屏覆盖层，v3.96：三栏「笔记｜PDF｜Agent 终端」，fixed inset-0 z-40，
                             #   左右栏收起＝栏块常挂载负 margin 滑出（ccode-reader-panel，宽度不变：Monaco/xterm 零重排零搬移，
                             #   PDF 适配重算在 PdfContinuousView 停稳防抖收口；禁止改回条件卸载），
                             #   Esc 退出级联最优先，底下终端/PTY 保持挂载；右栏 = 阅读会话标签 xterm 宿主搬移，注入由 TerminalPage 供给；
                             #   跨页进入的退出回来源页（setReaderReq 在 store 层自动记 fromPage、closeReader 回跳）+
                             #   退出同时直接关阅读会话标签、不弹确认（正在生成的回应一并中断；requestCloseTab 的「进程活着」
                             #   判定对常驻交互式 CLI 恒真、每次退出都会弹，故不走它；2026-09-20 用户拍板）+
                             #   进入启动占位：标签派出前不闪「未在运行」卡、CLI 开屏前 xterm 黑底用遮面盖住（PDF 栏加载给页形骨架；
                             #   遮面重启触发器 = agentTabId——关掉旧标签重进后旧 startedAt 会原样带回来，
                             #   以它为触发器不重新挂遮面会露裸黑 xterm））+
                             #   PdfContinuousView（连续滚动 PDF 栏：±2 页虚拟化懒渲染、选段浮动条（译/◈问 AI/＋生词/⋯）、▦ 圈选截图、
                             #   ⌘+点击段落对照（结果进同款浮卡）、进度记忆/护眼反色/术语淡高亮、
                             #   ⌘/Ctrl+滚轮与触控板双指捏合对准指针缩放）、
                             # TemplatePickModal（科研项目注册成功后的研究流程模板选择层：顶部课题主题 +
                             # 六套内置模板 + 「不使用研究流程」（写 pipeline_opt_out 标记；只读文献走这条）/
                             # 「稍后再选」（不留痕，已填主题仍落盘）两出口）、
                             # CodingProjectView / OfficeProjectView（编程左工作树右会话可收；工作树事后分组、行内图标动作 / 办公左文档右对话+定时同款可收）、
                             # FuseDraftModal（「◈ 融合进任务书」预览编辑弹层：AI 融合稿可改后确认才写草稿）、
                             # TerminalStatusBar（终端底部常驻状态栏：未启动只留状态点 + 📂 目录胶囊；
                             #   进程起来后才有模型/思考档可点切 + git 芯片/保存/推送 + 时长/token） 等
  App.tsx                    # 应用壳：标题栏、侧栏、九页挂载。壳与标题栏/侧栏/缝透明，桌面磨砂从窗口底透上来；
                             #   顶栏帮助菜单（HELP_MENU：命令面板左侧 ? 钮，分组下拉，关闭范式同收件箱）
  App.css                    # 主题令牌与壳层样式。侧栏罩色：展开 42%、图标态 28%、选中行 88%；Linux 与减少透明度回落实心
  feedback.ts                # 反馈与提需求纯逻辑：类型闭集/环境行/正文与主题拼装/mailto 通道/端点负载/截图常量（≤3 张 ≤2MB）与邮件附件注记（tests/feedback.test.ts）
  components/FeedbackModal.tsx # 反馈表单弹层（帮助菜单与设置→关于双入口）：三通道自动降级（端点→邮箱直发 SMTP→mailto）+ 邮箱直发配置视图（预设/自定义按端口推 STARTTLS、换账号强制重填授权码、草稿回填）+ 截图附件 + 已发送记录
  components/HelpDialogs.tsx # 帮助菜单两个内容弹窗：诊断与日志（get_app_log + export_diagnostics_bundle）、关于（含第三方许可内页，feedbackEnvLine 复用环境行）；快捷键速查曾短暂存在后按「不与命令面板/设置/说明书重复」删除（2026-10-12）
  components/CommandPalette.tsx # ⌘K 面板
  components/LaunchMenu.tsx  # 启动栏下拉菜单组件：portal 到 body、分组标题、键盘导航，替代原生 select
                             # （Agent/配置/模型三段共用；隐藏配置沉「已停用（可手选）」组）
  components/StepEvidenceChip.tsx # 步骤卡证据徽标：读当前步骤报告，显示质量状态与未决标记计数（解析在 step-evidence.ts）
  components/ReviewDecisionList.tsx # 步骤上的审查/待核实清单：逐条接受、拒绝、修改，写回报告后再接回对话
  components/PendingConfirmList.tsx # 检索步文献清单：待确认纳入/排除、已纳入移出、已排除恢复；行上现查 IF/分区/TOP；
                             #   指标表状态与排序跟在「纳入所选 / 排除所选」右侧，没有待确认时单独靠右
  components/CloseoutPack.tsx # 项目卡「完结文件」：按脉络列出已写出的文件，点开到文件页
  components/QuickChatHistoryMenu.tsx # 侧栏「快速开聊」右键的 scratch 历史浮层（继续上次）
                             # 记住选择后左键直达、右键回看；行样式与弹层「继续上次」一致
  reasoning-effort.ts        # 网关思考档：逗号多选 + @开场默认；单词旧值=单档（tests/reasoning-effort.test.ts）
  components/GatewayLibrary.tsx # 连接页网关库：五槽/密钥/获取模型/按槽体检/逐模型策略三态；
                             # 思考档勾多档，开场默认单选（reasoning-effort.ts）
                             # Base URL 主输入（2026-08-31）：空槽与仍等于旧主值的槽跟随主输入、手改即脱离；
                             # 全部测速按 URL 去重（同址只探一次，摘要前端镜像给同址槽）
  components/HoverTip.tsx      # 应用内 tooltip 共享件（v3.93 提取自 ProjectGroup）：useHoverTip + HoverTip，
                             # portal 到 body（免疫祖先 opacity/transform 的 fixed 包含块问题）、滚动/缩放即关、
                             # up 参数支持锚点上方弹出（行内动作栏 tooltip 专用）；PageFrame 的 RowAction 内置上方 tooltip
  components/ActivityHeatmap.tsx  # 用量页「活跃度」热力图区块（2026-10-12）：真 table role=grid + CSS 格子（几何全在
                             #   App.css .ccode-heat*，档位色 --heat-1..4 令牌）；去年同月 1 日到今天、与 range 解耦；
                             #   <1020 胶囊跟在「活跃度」后 / ≥1020 左栏紧凑双列（192px）；格子边长 11–20 整数；
                             #   到顶后卡片 hug 内容宽；16px 右边还剩 ≥220px 时右侧色阶+四项统计；
                             #   布局观察满宽哨兵（禁止观察 hug 主区，防抖动）
                             #   挂在 StatsPage empty 三元之外（页面空态是 range 口径）；共享单例 tooltip
                             #   （pointerover 委托 + 键盘焦点同款触发）+ roving tabindex 方向键漫游；
                             #   二期同日实装：点格/回车下钻日详情浮层（usage_day_detail 按日缓存、内滚不关、
                             #   z-60 弹层档；会话行直跳结构化会话视图、日期出口 sessionScopeReq kind:day）+
                             #   按 agent 筛选胶囊（usage_activity_agents 年矩阵一次拉、切胶囊纯前端过滤，
                             #   分档/活跃/峰值/连续随胶囊重算，streak 限所选年）；
                             #   数据自持（usage_activity 全历史非零日，refreshKey 由页级刷新驱动）
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES（六套，含 v3.97「LaTeX 论文」）；
                             #   每套 projectRules 纪律不同，settingsForTemplateApply 不落空表格
  lit-project.ts             # 文献-only 项目：建议添加目录 / 家目录禁入 / 无流程时 inbox 落点
  task-md.ts                 # TASK.md 拼装纯函数（项目根/产物目录绝对路径）；pipeline-start 再导出
  pipeline-start.ts          # 一键开步共享链路（renderTaskMd/gatherTaskMdExtras 单一出处，弹层预览与落盘共用）；
                             # 工作区→终端交接单一出处 buildWorkspaceTerminalRequest（reuseKey 找回同工作区标签 +
                             # 无 prompt 时 resume 最近会话；步骤绑定换了 Agent 则不接回，见 keepWorkspaceResume）
  goal-run.ts                # 普通目标/「验收后写入」共享启动链（审计 §4.10）：prepareGoalRun 先拼上下文
                             # （packGoal/goalLine 可覆盖）再 task_prepare_run（contextText 冻结快照）；
                             # goalRunTerminalFields 出终端请求公共字段；页面只补 model/预览等自有字段
  workspace-resume.ts        # 「去终端」resume 挑选纯逻辑（workspace 名 + 仓库路径匹配，排除归档/内部/live；
                             # keepWorkspaceResume：步骤绑定是另一家 Agent 时不接回；
                             # workspaceCarrySource：换 Agent 继续时要不要问带简报。tests/workspace-resume.test.ts）
  presets.ts                 # 端点预设表（provider 级一份多槽：PROVIDER_PRESETS 各协议槽端点 + 推荐模型 ≤3 + 适用 Agent；
                             #   presetsForAgent 按 Agent 协议槽派生下拉；加供应商 = 加一条；仍只收官方/公开端点——
                             #   商业中转不进默认表，2026-10-12 拍板，tests/presets.test.ts 钉住）
  preset-flow.ts             # 一键接入纯逻辑：推荐模型与目录求交（intersectCatalog，不整目录预填）、「同时绑到」
                             #   协议兼容目标推导（extraBindTargets，复用 apiKindOf；多协议 Agent 优先 openai）、
                             #   多 Agent 槽位拼装（gatewayDraftSlots：主槽=表单地址，预设分槽值优先于同址回落）
                             #   （tests/preset-flow.test.ts；约定见 conventions/profiles.md「一键接入」）
  mcp-presets.ts             # MCP 内置预设表（加预设 = 加一条；密钥一律 ${VAR} 引用；
                             #   remote 填 url/headers，stdio 填 command/args，`{home}` 打开表单时展开为家目录；
                             #   需本机安装的用 setup 步骤引导，不代装）
  mcp-display.ts             # MCP 页展示纯逻辑：协议徽章固定识别色（stdio 紫/remote 蓝）+ 命令路径智能缩略
                             # （家目录折 ~、段数>3 且 >28 字符才砍中段留首尾）+ 收编条目判定与删除影响面
                             # （isAdoptedMcp/mcpDeleteImpact/mcpOriginLabel，tests/mcp-display.test.ts）+
                             # 分发状态徽标 mcpDistBadge（modified/missing/disabled_externally 三异常态文案与识别色）+
                             # 命令路径告警徽标 mcpCmdPathBadge（relative/missing）与收编解析附注 mcpPathResolveNote
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）+ 项目列表状态点 projectRailStatus
  run-model.ts               # Project→Task→Run 前端镜像：inferTaskKind / 工作台白名单 isWorkbenchSurfaceRun
                             # （登录/无头/空闲 shell 不进「正在进行」；阅读标签还开着则进）/
                             # pickRecoverableRun 找回可恢复 Run（排除 internal/login/watch/reader——阅读关掉就离开，
                             # 不进找回链）/ isRunProcessLive 活进程判定（保留标签不算运行中）（tests/run-model.test.ts）
  project-tasks.ts           # 人声明任务：资料范围（不带入/勾选/整个项目）/ 嵌套路径剪枝 /
                             # 声明步骤过滤（不含会话自动登记）/ 审核回流文案 /
                             # 保护文件夹勾选（验收写回保持原样，不是另存副本；tests/project-tasks.test.ts）
  project-agents.ts          # 项目 Agents 名册：每家默认配置 / 项目选用的模型 / 项目默认 / 声明步骤归属
                             # （不自动分派；tests/project-agents.test.ts）
  project-context.ts         # 项目环境包：名称/规则/顶层文件地图（启动注入）；
                             #   会话包 = 身份+目录+规则+跟用户走；目标包才带当前目标/技能/尚未完成/验收写回；
                             #   空表格不进规则，有流程用模板纪律、无流程用工作方式默认条
                             # （tests/project-context.test.ts）
  coding-lanes.ts            # 编程车道覆盖层：有树无行按分支现算、theme 分组、空闲/Agent
                             # （tests/coding-lanes.test.ts）
  agent-caps.ts              # 能力表前端消费：定时任务禁选未验证无头；Grok 标「会批准全部操作」
                             # （tests/agent-caps.test.ts）
  work-mode.ts               # 项目工作方式（科研/编程/办公）与编程状态归类、办公文档类型/预览形态；
                             # 文件行「进行中」只认 officeFileReuseKey 对上的活标签（仓级仍 isOfficeInProgress）；
                             # 顶栏课题主题可见性 headerShowsTopic（科研项目含无流程都展示，身份四件套之一）
                             # （lockWorkModeFromConfig / codingFactChips / codingDivergenceBar /
                             #   groupByWorkMode 项目栏分段 / projectSwitchRows 收起态课题名切换菜单行；tests/work-mode.test.ts）
  session-title.ts           # 会话列表展示标题清洗（去 URL/绝对路径/中断/resume/未命名，取首句；不写回源文件）
                             # （tests/session-title.test.ts）
  project-status.ts          # 项目页状态行 / 工作区要你管排序 / 笔记过滤 / 办公继续上次与问 AI 建议
                             # / 本项目会话过滤（filterProjectSessions，排除无头 AI / 问 AI / 阅读注入 / 已归档；默认全部列出）
                             # （tests/project-status.test.ts）
  mac-titlebar.ts            # macOS Overlay 顶栏左边距：窗口态红绿灯让 78px，全屏取消
                             # （macOverlayPadClass / useMacFullscreen；tests/mac-titlebar.test.ts）
  folder-groups.ts           # 项目页分级文件夹树（本层文件与子夹并列；可剥 papers/notes/data）
                             # 展开路径 persist（默认全收起，跟随上次；tests/folder-groups.test.ts）
  project-rail.ts            # 运行页左栏项目区：活标签已添加项目 ∪ 科研活跃工作区 ∪ 当前项
                             # （attributeRailCwd / buildProjectRailSections；tests/project-rail.test.ts）
  workbench-hero.ts          # 工作台主卡纯逻辑：当前工作按运行标签归属（注册名优先；隔离目标副本按
                             # runId/taskId 归属表归回真实项目，不按 cwd 拆卡；同名项目按 contextPath 路径选，名字只作唯一命中回落）、
                             # 步骤取流水线第一个未合并步、「继续工作」有标签则聚焦，否则按 runId 找回原 Run，再回落进项目/真进入；
                             # pickWorkbenchNow = 正在进行列表（大卡 + 紧凑行）；runningCount 只算活进程
                             # （isRunProcessLive，已退出/未启动的保留标签留在 runs 里可继续但不冒充「正在工作」）；
                             # 副行优先待验收/进行中目标；最近对话先按可见范围过滤（归档/内部无头/问 AI/阅读注入不列，
                             # 与 filterProjectSessions 同口径）再与项目侧栏同一套清洗，未命名不列；
                             # workbenchRecentRows = 已添加项目 ∪ 会话扫仓库（办公/新建无会话也列出），
                             # 与最近对话默认最多 10 条（tests/workbench-hero.test.ts）
  lit-watch.ts               # 文献雷达纯逻辑：日分组/关键词分组（groupEntriesByKeyword，取 keywordsHit 首词、
                             # 未分类恒末）/趋势/直链转换/全文可得性分流（fulltextLinkFor：arxiv abs 与 .pdf 直链=可下载，
                             # DOI/落地页=来源，不再摆禁用下载钮）/已读判定/雷达筛选（entryPassesFilter
                             # 与 lit_watch.rs 双端镜像，指标未知放行不误伤；快筛解读 watchExplainPrompt /
                             # parseWatchExplain 五节学术口径；卡片展开按项目记忆（默认收起）；
                             # tests/lit-watch.test.ts）
  md-image-hydrate.ts        # md 阅读/聊天图片占位水合：每次 layout 扫 data-md-src，本地图缓存
  agent-binding 体系（2026-10-15 定稿，全文 docs/conventions/agent-binding.md）：
  project-agents.ts          # 绑定纯逻辑单一出处：slotPrefs（discuss 槽>项目默认）/ taskBindingLaunch /
                             #   resolveStepLaunch（步骤槽>discuss）/ resolveTaskModel（目标三档回落）/
                             #   workspaceLaunchChain（手选>步骤>wsLast 三链）/ stepSlotKey /
                             #   CHAT_BINDING_SLOT（项目对话）/ DISCUSS_BINDING_SLOT（问 AI·聊想法）
  render-gate.ts            # 通用并发槽 RenderGate（限并发 + FIFO + 槽位直接移交）：PDF 位图重渲过闸逐页错开，
                             # 停稳换挡后的补渲不再挤同一帧（tests/render-gate.test.ts）
  reader.ts                  # 沉浸阅读区纯逻辑：分栏钳制与像素换算（含收起滑动量 readerPanelSlideMargin，栏宽不变负 margin 滑出）/
                             # 圈选命中与 canvas 映射/截图注入格式/
                             # glossary 表格契约（与 reader.rs 双端镜像，改动需同步）/段落边界提取/术语匹配/
                             # 进度与护眼存储键/翻译面板高度键（readerSplitT，未拖过不落键 = 内容自适应）/译文卡钉位键（readerTlPinned）与悬浮球位键（readerTlBall，PDF 栏百分比 0–100、渲染层按球半径贴边兜底）/悬浮卡尺寸键（readerTlCard，240×140 下限、拖过才落键）/
                             # PDF 适配宽度 nextFitScale（亚像素门槛，防滚动条槽振荡闪白）/
                             # 手势缩放 clampPdfScale、pdfWheelZoomFactor（组件绑定共享在
                             # components/use-pdf-zoom.ts：布局倍率即时重排、渲染倍率 renderScale 延迟重绘、
                             # 锚点实测修正不用公式，连续滚动与单页预览同一套；对齐官方 pdf.js viewer，
                             # 勿退回整层 transform 跟手）/
                             # 画布像素上限 pdfCanvasOutputScale（tests/reader.test.ts）
  draft-review.ts            # 写作步评审机械红线（摘要待核实/G编号/待绘制/叠号）、划选批注追加与退回提示词
  md-path.ts                 # 阅读版式覆盖的 md 族（md/markdown/mdx/qmd）与 html 判定
  md-toc.ts                  # md 浮动目录：≥3 标题才出、slug/展开 details
  md-code-chrome.ts          # 阅读态代码块语言名 + 复制；mermaid 围栏打标
  md-block-map.ts            # md 渲染块→源码行映射（阅读态双击段落跳编辑态定位）：lexer raw
                             # 累积算行（无参调用，带 options 丢 md-math 扩展）+ 上屏 DOM 惰性
                             # 配对（md-code/md-mermaid 归一 pre），失败回落纯切换
                             # （tests/md-block-map.test.ts，含 parse→清洗→装饰全链路）
  md-edit.ts                 # md 行内/行级格式编辑纯逻辑：加粗/斜体/删除线/行内代码标记切换、
                             # 列表·任务·引用前缀整组切换、回车续列表、链接包裹；
                             # 编辑器格式行与 ⌘B 等快捷键同一套（tests/md-edit.test.ts）
  mermaid-blocks.ts          # mermaid 围栏检测（无围栏不加载 chunk）
  mermaid-sanitize.ts        # mermaid SVG 二次清洗（strict + 剥脚本/链接）
  html-preview.ts            # html 沙箱预览：stylesheet 内联 / 本地图 / srcdoc
  md-math.ts                 # md 阅读版式公式渲染（批次 E）：marked 扩展按 Pandoc 口径切分 $/$$
                             # （边界规则/转义/代码块不渲染/货币不误判）+ renderMathInto 懒加载
                             # katex+CSS（独立 chunk 不进主包，失败回落原文，tests/md-math.test.ts 25 例）
  task-cards.ts              # 任务卡纯逻辑：按步骤分桶/卡片排序/会话按卡分组/卡片 kind（idea 想法卡 / draft 讨论卡）过滤；
                             # 「＋ 话题」占位按当前步骤给例子（ideaTopicPlaceholder，综述大纲不写对照实验）
                             # （tests/task-cards.test.ts）
  step-flow.ts               # 步骤内协同流程线纯逻辑：种子→before→agent→during→after→评审节点链
                             # （v3.97 起 after 档一律进主干，可选项带徽标但不抢当前节点；
                             #   demoReadPaperResource：「开读这一篇」仅示例课题精读步，普通模板只显示「开始」；
                             #   tests/step-flow.test.ts）
  skill-conflicts.ts         # 技能接口对账纯逻辑：产物冲突（skillOutputConflicts，outputs 两两相交）+
                             # 跨步骤链路（skillChainWarnings：inputs 找供给/outputs 对账预期产物，
                             # 支持 * 通配与目录/文件互含，推断接口打标；tests/skill-conflicts.test.ts）
  schedule-tasks.ts          # 定时任务纯逻辑：周期白话/相对时间/按 projectRoot 过滤（tests/schedule-tasks.test.ts）
  schedule-skill.ts          # 定时巡检种类：文献雷达 + 分类「巡检」的技能；新建种子 prompt / 草稿路径
                             # （value 用目录名不是 UUID；tests/schedule-skill.test.ts）
  inbox.ts                   # 收件箱分类胶囊纯逻辑：key 前缀→类别、分组、help dismiss 签名、人工请求通知 edge-trigger（tests/inbox.test.ts）
  app-update.ts              # 应用自更新展示纯逻辑：收件箱字段/合并、检查失败文案、http(s) 代理、下载进度
                             # （tests/app-update.test.ts）；真正 check()/安装在 store.ts
  chat-handoff.ts            # 聊天⇄终端交接表：chat_ok / peek / must_switch、等待态文案、斜杠是否要窥视 TUI、
                             # 聊天头状态 chatHeaderStatus（未开始不写「等待会话文件」，tests/chat-handoff.test.ts）
  slash-commands.ts          # 聊天斜杠命令保守常用集（未全量调研的 agent 只给 /help；tests/slash-commands.test.ts）
  ime-guard.ts               # 聊天 Enter 是否处于输入法组词（WKWebView 确认候选时 isComposing 已假；tests/ime-guard.test.ts）
  notify.ts                  # 长任务 OS 通知（仅「待确认」跃迁 + 未聚焦 + 30s 去抖；「已回复」不通知）；
                             #   注意：通知插件桌面端无动作按钮/正文点击回调（App.tsx registerActionTypes/onAction 仅移动端生效，
                             #   2026-09-15 核对插件源码）——桌面点通知只激活窗口，「待确认」跳转由 App.tsx 窗口获焦时的
                             #   右下角提醒条补位（点「去处理」直达终端标签，按待确认集合去重）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑（含冲突 unmerged 组）
  file-icons.ts              # 文件类型小徽标纯逻辑：扩展名 → 短标签 + 固定识别色；
                             # isPreviewableImagePath（png/jpg/gif/webp/svg，tests/file-icons.test.ts）
  sheet-preview.ts           # Excel 预览纯逻辑：列字母 / 单元格引用 / 截断文案 /
                             #   合并区 clipSheetMerge / sheetCellHidden（tests/sheet-preview.test.ts）
  editor-languages.ts        # monaco 语言注册（批次 E）：monaco-editor 0.56 ESM 不带 latex，
                             # 自带紧凑 Monarch 定义覆盖 .tex/.sty/.cls/.bib（tests/editor-languages.test.ts）
  workspace-visibility.ts    # 聚焦步骤工作区可见性过滤纯逻辑（不匹配任何步骤的手动工作区始终可见，
                             # tests/workspace-visibility.test.ts）
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  main-history-save.ts       # 科研步骤卡一键「存进历史」：冲突拦截 / 白话说明 / 路径（tests/main-history-save.test.ts）
  chat-reply.ts              # 聊天长回复按小标题分段（识别代码围栏）、正文里的项目文件、确认按钮是否给出（tests/chat-reply.test.ts）
  paste-guard.ts             # 终端粘贴防线：剪收尾回车、shell 多行先确认、备用屏原样（tests/paste-guard.test.ts）
  terminal-links.ts          # 终端行绝对/相对路径与行列号（`:行:列`、句尾标点不吞、lookbehind 起点
                             # 让行首边界字符后的路径也命中；相对候选点击时经 terminal_link_target 终审）
                             # ＋ hitCellRange 把字符下标换算成单元格列号（逐格自算，宽字符不错位）（tests/terminal-links.test.ts）
  terminal-notify.ts         # OSC 9 / 777 通知标题（777 三段式取标题）与 OSC 9;4 进度解析
                             # （parseOsc9Progress → 标签条徽章），从画面文字里抽走（tests/terminal-notify.test.ts）
  terminal-replay.ts         # 重启回放取缓冲尾部纯文本（tests/terminal-replay.test.ts）
  terminal-protocols.ts      # 内嵌终端协议：Kitty 键盘查询应答（只宣布 flags 5；无修饰功能键保持传统
                             # 序列、只改写 Esc；带修饰方向键走 CSI 1;mod 字母形）、弹栈认层数、
                             # XTVERSION 两问法统一 DCS 应答、XTGETTCAP 答 Ms、OSC 52 限长写剪贴板、
                             # Kitty 贴图按文件头认 MIME 且支持 m=1 分块、通知/贴图/剪贴板共用
                             断帧 pending 管线（tests/terminal-protocols.test.ts）
  terminal-input.ts          # 终端输入侧纯逻辑：shell 路径转义 escapeShellPath、拖入多路径拼接 joinDroppedPaths、
                             # 聊天拖入 joinDroppedChatPaths、dropHitsRect、Kimi CSI-u 序列、
                             # Shift+标点补发（229 只补 ASCII 标点，中文上屏不补，避免一字两遍）、
                             # 剪贴板图片条目判定/MIME→扩展名/粘贴反馈文案（tests/terminal-input.test.ts）
  terminal-welcome.ts        # 终端未启动空态：isTerminalIdle / 卡上「将在 … 启动」目录文案
                             # （tests/terminal-welcome.test.ts）
  terminal-wheel-scroll.ts    # 触控板/滚轮合帧：capture 阶段截住 wheel，同帧多枚合成一枚再派回深层 target
                             # （滚动卡顿修复 2026-09-21，拍板记录 architecture.md §10；tests/terminal-wheel-scroll.test.ts）
  terminal-row-reuse.ts       # DOM 渲染器滚动按行挪位：视口平移不到一屏且行文字未变时挪已有节点、只重画新进行
                             # （滚轮卡顿修复 2026-09-22，WebGL 无逐行 DOM 自动空操作；tests/terminal-row-reuse.test.ts）
  launch-menu.ts              # 启动栏下拉菜单视口定位 placeDownMenu：只从锚点下沿向下长，空间不够缩短高度
                             # （tests/launch-menu.test.ts）
  tab-working.ts             # 终端标签「生成中」虚线圆：PTY 出字才转；启动注入等回复期间 TUI 开屏不熄灭；会话已落完助手正文；PTY 仍出字时 Codex 中途 done 不得停转圈
                             # 立刻停，sticky working 不得续命；armed 回合不因 PTY 2s 静默熄灭（推理思考间隙≠回合结束，
                             # armed 只由会话层收尾/确认/退出清，未 armed 的 working 仍 2s 静默熄灭兜底——2026-09-15 修正
                             # 「终端还在出字、标签与聊天层却无运行态」）；完全静默 120s 硬上限熄灭转圈但保留 armed（PTY
                             # 再出字即复亮，2026-09-19：思考/执行期间 TUI 动画仍在出字，完全无声=回合已结束或链路冻结）；
                             # 收尾判定被 ptyLive（8s 窗）推迟时 scheduleSettleRetry 保证 PTY_LIVE_MS+1s 后强制重判一次
                             # ——否则会话文件再无新写入时签名门拦住轮询、转圈永久冻结（2026-09-19 综述大纲跑完实测）；
                             # 出字时间戳记任意 agent 输出（焦点重绘抑制窗内也记，
                             # 防切聊天瞬间被静默计时器误杀）；动画禁 CSS rotate（WKWebView 转轴圆心晃）、也禁 dashoffset
                             # 关键帧（主线程重绘，xterm 出字满载时一卡一卡）——8 段虚线按相位差闪 opacity（合成器线程，
                             # 2026-09-15 实测重做）（tests/tab-working.test.ts）
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  tab-drag.ts                # 标签条拖拽排序纯逻辑：位移钳制 + 目标槽位判定（>= 中线守末槽边界，
                             # tests/tab-drag.test.ts）
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）：四套深色 + 四套配对浅色 twin，
                             # ANSI 16 色 + 光标 + 选区全在表内；resolvePaletteId 按主题亮暗自动换 twin
                             # （新增调色板须同步 settings.rs KNOWN_PALETTES，否则被静默丢弃，tests/terminal-palettes.test.ts）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  quick-chat.ts              # 快速开聊弹层「随手聊历史」纯逻辑：只列 ~/ccode/scratch（isScratchCwd），
                             # 排除工作区/已注册项目/其他仓库/归档/内部/live/源文件已删；
                             # pickQuickChatHistory 用 store 会话列表现算；sidebarLaunchesDirect
                             # 侧栏记住选择后直达；pickRememberedProfileId 直达只认记住的那条
                             # （tests/quick-chat.test.ts）
  confirm-dialog.ts          # 确认框键盘语义：Esc 取消，Enter 激活当前焦点钮；设为全局挡路可 focusCancel（tests/confirm-dialog.test.ts）
  custom-runtime.ts          # 自定义运行时默认 cwd：仅空目录/scratch 启用（tests/custom-runtime.test.ts）
  gateway-slot.ts            # Agent→协议槽与目录刷新优先槽（与 slot_for_agent 双端镜像，tests/gateway-slot.test.ts）
  command-palette.ts         # 命令面板过滤纯逻辑
  stats-insight.ts           # 统计页花费环比 / 缓存命中率 / 会话标题回落纯逻辑；compact/fmtCost 统计页统一数字方言（tests/stats-insight.test.ts）
  usage-activity.ts          # 活跃度热力图纯逻辑：周一开头年网格 / 月份标签避让 / 非零天四分位分档（GitHub 同构）/
                             #   streaks（今天宽限，跨年不断档）/ yearStats / 中文日期短语 /
                             #   布局：heatCellPx 11–20 夹紧、heatRailLeft、heatWideAside（40px 回差）；
                             #   口径铁律：着色、活跃、streak 恒只算非 internal（official 计入），着色量=四类合计（tests/usage-activity.test.ts）
  gateway-balance.ts         # 网关余额卡纯逻辑：主机命中 / 站点币种金额 / 已用百分比 /
                             #   大数字拆币种符号 splitBalanceAmount（整串 2xl 头重脚轻、tokens 更长）/
                             #   同站账户合并 groupWalletAccounts（**分组键 = origin + account，不能只按
                             #   origin**：同站两个账户必须分开；认不出账户的行并进本站第一组不丢行）+
                             #   walletAccountTitle（单网关用网关名，多网关/并排时标「站点 · 账户」）+
                             #   walletTokenQuota（三条分支合一：token 数据 > billing 提升值 > null；
                             #   **回落提升值必须带 source !== "wallet"**，否则拿钱包余额冒充密钥额度）+
                             #   walletExpirySoon（只有临近/已过期才在卡面露到期，0 = 无到期不算 1970）+
                             #   walletUnlimitedLine（不限额度也要把已用说出来）+
                             #   walletUnlimitedFill（开口条：同卡已用的 log1p 比，最长停在 95，已用 ≤ 0 不画）
                             #   （tests/gateway-balance.test.ts；与 gateway_balance.rs WALLET_HOSTS 双端镜像）
  plan-quota.ts              # 订阅余量卡纯逻辑（用量页，与 gateway-balance.ts 并排的第二张卡）：
                             #   供应商显示名/切换标签/窗口名/重置倒计时/重置卡；
                             #   **双窗同构**（2026-09-21）：最紧的窗口走大数字 + 通栏粗条，另一窗收成一行
                             #   （名称 + 随行拉长的条 + 百分比贴条尾 + 绝对值 + 倒计时；条与密钥行共用，见 StatsPage SecondaryUsageTrack），
                             #   最紧的窗口排第一（planWindowsByTightness / planPrimaryWindowIndex，并列取靠前者）——
                             #   本机实测 5 小时 0%、周 100%，固定锚 5 小时会把爆掉的周额度藏住；
                             #   planResetRemain：卡面只写「还有 28 小时 51 分」，时刻放悬停（formatResetPoint）；
                             #   quotaTone：分档 → 条/数字同一套颜色令牌（正常档**不着色**，一片彩字反而看不出该管哪个）；
                             #   绝对值走 formatQuotaPoints（手写千分位）+ planAbsoluteQuotaPair（百分比旁；
                             #   已用超过总量时按总量封顶，140,023 显示成 140,000 / 140,000；解析层仍如实；
                             #   MiniMax 只回百分比就不显示）；
                             #   重置卡两列平铺不套内卡（auto-fit），名称「5 小时重置卡 / 周重置卡」，
                             #   张数做微型胶囊；期限卡面只写日期，时刻悬停；3 天内/已过期标黄；
                             #   planResetCardHighlight：只给最紧且 ≥90% 的那张按钮上强调色，**不禁用**另一张；
                             #   planWindowUnused：窗口一点没用（0%）**只劝退，不禁用按钮**——用户拍板 2026-09-21
                             #   「看着劝退吧 不拦截」。落地：①确认框写已用 X% ②0% 确认按钮改「仍要用」；
                             #   **重置卡里不写「已用 X%」**（用量已经在上面两个窗口）；
                             #   planLevelLabel 全小写等级首字母大写（智谱实测回 level:"max"）
                             #   （tests/plan-quota.test.ts）
  hotkeys.ts                 # 快捷键组合串纯逻辑
  themes.ts                  # 主题清单单一出处 + isLightTheme() 亮暗判定单一出处（禁另造判定；
                             #   custom / custom-light 不进十四套清单）
  theme-swatch.ts            # 设置页主题色卡预览色：从 App.css 源文本抽 rail/canvas/cta/l1，
                             #   禁止临时切 data-theme 再 getComputedStyle（tests/theme-swatch.test.ts）
  custom-theme.ts            # 自定义主题：三色种子派生全套令牌 + 另存色卡列表
                             # （tests/custom-theme.test.ts）
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  resume-profile.ts          # 恢复会话的 profile 挑选纯逻辑：codex 内联 provider 会话（rollout 记
                             # model_provider="ccode" 或派生名 ccode-<网关短id>）按网关挑绑定；
                             # openai→官方账号（未登录改网关）；其他名字（客户端 custom 等）只挑网关、不掉进官方；
                             # 软停用（hiddenProfiles）跳过停用项——wishedId 指向停用项同样跳过，全停用时回落含停用项池不拦死
                             # （tests/resume-profile.test.ts）
  combo-field.ts             # 网关库逐模型策略三态（edit/readonly/hidden）纯逻辑（tests/combo-field.test.ts）
  ask-ai.ts                  # 项目区「问 AI」：选 Agent/配置/模型，可设为默认（tests/ask-ai.test.ts）
  ai-profile-choice.ts       # 设置页「AI 专用配置」选项拼装：一条配置的每个模型各占一项，value 用
                             # 不可见分隔符拼 profile id 与模型名（tests/ai-profile-choice.test.ts）
  conversation-tools.ts      # 对话回放：连续工具调用聚合成一条执行记录（tests/conversation-tools.test.ts）
  dep-check.ts               # 依赖体检前端镜像：DTO 判定与 DOM/Tauri 解耦（tests 同名）
  gateway-draft.ts           # 网关库槽位纯逻辑：effectiveSlotUrl 主输入跟随/脱离、slotsFollowMaster、firstProbeableSlot
  goal-review.ts             # 目标验收弹层分组与文案：科研按文献/笔记/数据/论文、工作按文档/表格/幻灯（tests/goal-review.test.ts）
  history-view.ts            # 历史时间线白话翻译层（✓保存进项目/⚙自动保存/◔保存，hash/分支名降为二级）
  step-review.ts             # 科研步骤评审档案闭集 screening/files/acceptance/default；一张审阅壳按类型拼区块（tests/step-review.test.ts）
  step-evidence.ts           # 步骤卡证据徽标纯逻辑：从报告文本解析质量状态与 [待核实]/[待确认] 计数
                             # （报告自述，不是系统认证；tests/step-evidence.test.ts）
  review-save-copy.ts        # 科研保存链白话：保存进项目；不是编程合进基准、不是科研验收决定
  kickoff-inputs.ts          # 开步确认弹层「上一步接到的输入」芯片；isDeclaredStepInput 排除已声明输入，不进未登记列表
  lit-list.ts                # 无流程科研文献/笔记列表：展示名、编号、状态与过滤纯逻辑
  model-switch.ts            # 各 CLI 多模型注入能力表 + 启动栏提示纯逻辑（对应 agent_specs.model_switch）
  nav-capsule.ts             # 侧栏可配置胶囊入口（恢复侧栏始终保留，不在此列）
  project-context-load.ts    # 启动环境说明拼装：读档案卡和顶层目录，失败仍返回能用的短包
  research-report.ts         # 研究报告节抽取/相对路径解析（只认显式报告节，不认 TASK 指令或推断结论）
  screening-review.ts        # 检索/筛选评审主面：计数/待拍板/筛选决定、表默认 pending、文件分组；included.md/json 不与表并列摊 diff；
                             #   displayCitationTitle 只改清单显示（苹果字符、拆开的化学式），不回写 json
                             # 移出：removeToFetchEntry 不重排编号、removeRisRecord 按 DOI/标题删整条、notePathForRecord / bibMentionsRecord 只提示不删；
                             # 接口缓存、脚本、.gitignore 进「过程」，不进非 Git 产物清单；
                             # pendingConfirmCleared = 有篇且无 pending，步骤卡据此自动勾「核对待确认篇目」（tests/screening-review.test.ts）
  review-file-groups.ts      # 精读/写作评审文件分组：笔记/稿件/引文/待获取/过程（tests/review-file-groups.test.ts）
  closeout-pack.ts           # 项目卡完结清单：最终稿 / 源稿 / 图 / 文献 / 核对 / 笔记（tests/closeout-pack.test.ts）
  research-tools.ts          # 科研工具注入 withResearchTools；定稿步同时挂 output/endnote.docx 与 output/zotero.docx（LaTeX 不挂）；
  skill-slots.ts             # 技能位单一出处：{skill:锚名} 占位解析（provides 优先、名字兜底）、行为键判定、provides 映射 hook；锚名闭集见 pipeline.md（tests/skill-slots.test.ts）
                             # 域稿刷新收成一句可选「换样式时打开域稿」，不挂文献库同步按钮；来源只认 lit_source
  review-decisions.ts        # 审查报告 R/S 与待核实 V 的拆条、接受/拒绝/修改写回、点完后的继续提示
                             # （tests/review-decisions.test.ts）
  academic-mcp.ts            # 检索步「配置学术检索 MCP」：预设名、登录注入；登录态由 academic_mcp_login_status 回一句现状（tests/academic-mcp.test.ts）
  session-filter.ts          # 对话页筛选纯逻辑（tests/session-filter.test.ts）
  session-search.ts          # 对话搜索纯逻辑：分词、元数据即时过滤、正文命中合并排序
  session-transfer.ts        # 会话导入向导纯逻辑：状态文案、目标目录预填、可否执行
  step-decisions.ts          # 决策项：答案落任务书草稿固定小节；isTaskMdStub = 空/仅决策/仅评审沉淀不算可执行正文，resolveTaskMdSource 走模板拼装并接沉淀（decisionGate/orderedAnswers/parseDecisions，tests/step-decisions.test.ts）
  terminal-resume.ts         # 终端会话恢复的标签复用与配置挑选纯逻辑（2026-09-08 审计修复）
  terminal-geometry.ts       # 启动前收不收栏、没量到格子就不起进程、起来之后谁可以改行列
  store.ts                   # zustand 状态。applyTheme 同步原生窗口外观；Windows 上同时把整窗 Mica 切到 micaDark/micaLight
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login/readonly_args 只读模式参数/
                             #   model_switch 运行中切模型（claude/gemini/kimi/grok 带参直切；codex/opencode 唤选择器——两家 CLI 无带参直切：
                             #   codex /model 无内联参数（源码 supports_inline_args 不含 Model）、opencode /models run 无参，2026-09-15 实证；
                             #   状态栏 picker 档点芯片即唤选择器、不摆模型假菜单）与
                             #   effort_levels 思考档槽位（claude /effort 五档、kimi on/off、qwen 0.22.0
                             #   /effort 五档实证；codex 待实机）；
                             #   能力表三字段 fail-loud（原因即用户可见文案，后端报错与前端置灰同源）：
                             #   set_global（cursor 不支持）/ mcp_write（grok 只读，请用 grok mcp add）/
                             #   skill_dist（cursor/grok 强制 copy）——global_config/mcp.rs/skills.rs 全部改查表，
                             #   前端经 agent_capabilities command 读表置灰）；
                             #   请求策略通道表 request_policy_support（逐字段按入口记账：
                             #   inject=启动注入 / persist=仅设为全局 / tui=仅会话内命令 / unsupported / unknown；
                             #   只认二进制/配置 schema 实证，调研录 matrix §9 第 8 条；agents.rs
                             #   apply_request_policy_env 按表注入启动 env，未实证一律不注）；
                             #   resolve_binary 兜底候选目录 binary_candidate_dirs 同在本模块（macOS 含 /Library/TeX/texbin）
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底）+ readonly_launch_args（聊想法只读注入）；
                             # 官方账号 Codex：apply_official_inject 必带 -c model_provider="openai"（内置 ChatGPT 渠道；磁盘
                             #   config.toml 的网关默认会盖过订阅，不得省略；只影响本进程、不写 model_providers 块）；
                             #   login_cmd = login --device-auth（CLI 自带设备码，不抄 cc-switch 的 in-app OAuth）；
                             # codex 内联 provider 参数 codex_inline_provider_args 单一出处（启动注入与外部恢复命令共用：
                             #   新会话 provider 名 ccode-<网关短id>；旧 rollout 仍记 model_provider="ccode"，外部恢复缺 -c 定义报 provider not found；定义只含
                             #   base_url/env_key 引用不含密钥）；
                             #   网关启动另加 -c web_search="disabled" 与 service_tier="auto"（盖 ChatGPT
                             #   登录默认；官方账号不注；不写 config.toml）；不注 features.apps=false（0.154 会把
                             #   Consensus/Undermind 收成 mcp__<名> 占位，unsupported call）；内置 codex_apps 改关
                             #   plugins.codex-app-tools@openai-bundled.enabled=false（mcp_servers.codex_apps.enabled=false
                             #   报 invalid transport）；禁止 enable_mcp_apps；
                             # grok GROK_CONFIG overlay 单一出处 grok_config_overlay：白名单（grok-build OVERLAY_ALLOW_PATHS，
                             #   fail-closed）只放行 [models] 全局块——allowed_models 收敛 + 请求策略五项全局默认（headers 走
                             #   $VAR 引用不落密文）+ 有启动模型时写 default（1.0.34 实证：开会话前先拿 config.toml 的
                             #   [models].default 比对 allowed_models，不匹配直接拒启动，GROK_DEFAULT_MODEL 偏好在这道门之后才
                             #   生效——全局 default 常是别家绑定「设为全局默认」留下的，故必须覆盖；memory：2026-09-20）；
                             #   [model.<id>] 不在白名单，api_backend/context_window 由中转 /models 目录
                             #   条目 apiBackend/contextWindow 或 config.toml 提供（调研录 matrix §9 第 8 条）；
                             # 选择器显示名统一「配置名 · 模型」（claude _NAME 槽 / codex catalog display_name /
                             #   kimi KIMI_MODEL_DISPLAY_NAME / opencode provider+models name）；
                             # claude 不写 CLAUDE_CODE_SUBAGENT_MODEL（保留 Task 参数/frontmatter/inherit 原生选择链），
                             #   用 --settings 只覆盖本次连接的非敏感模型选择；
                             # claude 长上下文声明 CLAUDE_CODE_MAX_CONTEXT_TOKENS + CLAUDE_CODE_AUTO_COMPACT_WINDOW
                             #   同值成对（启动注入与设为全局同键同条件；注册链确知 >200K 才注，防第三方模型被按 200K 提前 compact）
  model_registry.rs          # 模型能力注册表：逐字段查询链 = 用户覆盖 > 网关实测缓存（fetch_models 顺带沉淀
                             # OpenRouter 风格 /models 元数据）> 公共能力库（配置页 ⋯ 下载，models.dev 优先
                             # OpenRouter 回落，download_model_db/model_db_status）> 内置前缀表 > 关键词兜底；
                             # 字段 thinking/context/output/vision 全 Option（这层不知道就继续向下找，
                             # 显式 false 只在数据源如实给出时生效）；kimi capabilities/max_context_size、
                             # codex catalog、opencode reasoning/limit/modalities 全从这条链出；
                             # limit.output 兜底 8192（1.18 起 schema 必填）；宁缺毋滥（收错比漏报有害）；
                             # **声明层访问器（2026-09-26）**：model_context_size_declared_for /
                             #   model_output_limit_declared_for / model_supports_vision_declared_for /
                             #   model_thinking_declared_for——只认链上显式值，兜底层（fallback_context_size、
                             #   关键词 thinking、内置表确知多模态清单）不算。写进别人家 CLI 配置的值一律走这批，
                             #   分流：可省略的未知就不写（codex catalog 三键、codex -c 两键、kimi env 上下文），
                             #   必填的写保守下限（kimi config.toml max_context_size、opencode limit.*）；
                             #   确知多模态清单已收进 BUILTIN_CAPS（capsv），「不在表里」= 不知道而非纯文本；
                             # 字段新增 api_backend（grok 目录 apiBackend，闭集只收 chat_completions/responses/
                             #   messages；仅权威层有值，model_api_backend_for 供预览说实话）；
                             # fetch 沉淀解析兼容 grok 目录别名（contextWindow/context_window/_meta.totalContextTokens）；
                             # 文件型加载器 cfg!(test) 下不读本机真实缓存（链语义由 chain_field 单测覆盖）；
                             # model_context_size_authoritative_for = 仅权威层（用户覆盖+网关实测）的 context
                             #   访问器——grok 设为全局写 [model.*].context_window 专用（估值层不配覆盖中转目录）；
                             # 用户覆盖层有写入通道（2026-09-19）：网关库模型行「能力声明」编辑 →
                             #   set/clear/list_model_capability_override（原子写、前缀归一小写、api_backend
                             #   不进 UI 但往返保留；细则 conventions/profiles.md §6.1）；
                             # 下载公共库顺带提取定价（models.dev cost / OpenRouter pricing → 条目 cost 字段），
                             #   db_price_table 供 usage.rs 定价链消费
  capability_manifest.rs     # 能力写入清单（**不驱动写入**，只做记账与机器检查）：全表 WRITES 记「哪个 agent ×
                             #   哪个目标键 × 该键的 requiredness/completeness/harm × 依据强度」，
                             #   未知时动作**不存**、由 action() 从三个属性推——存下来会与属性漂移，
                             #   而漂移的表比没有表更坏。三档动作：Omit（可选就整个不写）/
                             #   ConservativeFloor（必填未知也写，但写下限并说清是下限）/
                             #   UnionWithDefault（完备声明 + 写少更坏 ⇒ 只加不减）。
                             # 为什么要有它：注册链前四层答「确知吗」、兜底层只答「给个数」，
                             #   把估值当声明写进别人家配置会**压低**真实能力（codex -c model_context_window
                             #   是硬覆盖，1M 窗口被按 128K 提前压缩）；更隐蔽的是完备声明键，
                             #   少写一个成员 = 断言「不支持」——kimi env KIMI_MODEL_CAPABILITIES 缺省集
                             #   ["image_in","thinking"] **不含 tool_use**，旧代码「非思考模型就不写」
                             #   静默剥夺了工具能力（根因：把「不知道」当成「假」；memory：2026-09-26）。
                             # 免除名单 NO_CAPABILITY_WRITES 带**理由**（NoConfigSurface / PolicyOnly），
                             #   不用裸字符串——空理由等于没记账；coverage_* 五条测试：
                             #   every_agent_is_accounted_for（新增第十家 CLI 时红，逼一次显式决策）/
                             #   no_stale_excuses / no_orphan_rows /
                             #   conservative_floor_is_never_used_for_a_complete_declaration /
                             #   kimi_env_capabilities_must_union_with_the_cli_default
  capability_golden.rs       # 能力写入的黄金样本测试装置（数据在 src-tauri/tests/golden/capability_writes.json）：
                             #   断的不是「某函数返回了什么」而是**用户可见的最终形态**——启动 env 表与
                             #   写盘的 toml/json 文本；单测各断自己那一段（agents.rs 断 env、global_config.rs
                             #   断 toml）互相不知道对方存在，kimi 那条错的注释正是这样活下来的。
                             # 放 crate 内而非 tests/ 目录：写入点私有/pub(crate)，集成测试够不到；
                             #   tests/golden/ 只是**数据**的位置约定，Cargo 只认 .rs 不会多出空 target。
                             # 期望值人工核对过二进制（不是跑一遍录下来）；golden_file_is_self_consistent
                             #   要求 id 唯一、why 非空、至少一条期望——防「加了一例但什么都没断」。
  profiles.rs                # 网关+绑定：gateways.json / bindings.json；keys.json 键=网关 id（0600）；
                             # list 物化成 Profile 视图（binding id 复用旧 profile id）；删除绑定=解绑不清密钥；
                             # 绑定级 api_backend 字段（grok 专用，仅设为全局写 [model.*] 消费；闭集校验 +
                             #   导出/导入 v2 随绑定走、非 grok 导入丢弃）；
                             # 有绑定的网关禁删；导出/导入 v2；见 docs/conventions/profiles.md
                             # 认证变量闭集 AUTH_BEARING_ENV 单一出处（无密钥校验 auth_bearing_env_name 与
                             #   导出剔除 sensitive_env_name 同源，防两处名单漂移；OPENCODE_CONFIG_CONTENT
                             #   这类内嵌整份凭据、名字无 KEY/TOKEN 的项只能靠闭集兜住）；
                             # 解绑清 settings 五字段（含 default_profiles / hidden_profiles）；schedules 的
                             #   profile_id 不置空——运行时硬 pin 拒绝静默换供应商，前端解绑前列受影响任务；
                             # §2 唯一约束单一入口 has_duplicate_binding(…, skip_id, candidate)：新建/复制/编辑/
                             #   导入 v2 四条路同一判据（编辑排除自身；选择没动时放行 update_selection_conflicts，
                             #   防历史重复对连改名都存不了——别当冗余删掉），漏一条就能「改一次模型」绕过；
                             #   导入另过 validate_profile_fields（agent 白名单/协议闭集/apiBackend/extraEnv 名），
                             #   不合格进 skippedSlots 原文列出，脏模型列表归一后才落盘
  combo.rs                   # Agent×模型×槽×体检求交器，DTO 下发；网关库走多 Agent 并集；
                             # 逐字段通道种类 channel_*（inject>persist>tui>unsupported>unknown 并集）随 DTO 下发，
                             #   inject_*_allowed 只认 inject，apply_to_profile 保留 persist 字段（设为全局要写）；
                             #   协议维度门控 channel_status_for（kimi effort 仅 kimi 协议通道，非 kimi 协议绑定按 unknown 计）；
                             #   混注提示覆盖思考与采样两种不一致（换模不重注）；
                             # policy_channel_note 通道形态说明（qwen 仅设为全局 / grok overlay 边界）随 DTO 下发
  drift.rs                   # 全局配置漂移：只比对 Mesa 写入键的子集，无关字段不算漂移
  gateway_store.rs           # 网关/绑定落盘与迁移；每槽体检摘要 latest-per-slot（摘要可按槽，绑定状态徽标
                             #   必须按「绑定默认模型 + URL/密钥指纹」取体检，禁「该槽最近一条」株连，§8）
  provider_id.rs             # provider 名 ccode-<网关短id> 单一出处；LEGACY="ccode" 仅旧 rollout
  tray.rs                    # 系统托盘：按 Agent 列绑定一键设为全局；选中态 dry-run 子集比对；不改启动栏默认
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）；
                             # 网关体检探针 probe_gateway（绕过 CLI 直连端点发 max_tokens=16 最小请求：
                             # 基础鉴权/裸流式 SSE 检测/带策略参数对比降级定位/自定义 Header 接受度，
                             # matrix §9 第 8 条）；请求策略字段校验（范围、claude effort 闭集、
                             # Header 名禁引号冒号、环境变量名 POSIX 字符集）
  global_config.rs           # 「设为全局默认」：agent 级事务批次写入（备份/回滚/恢复）；写成功即记
                             # settings.active_global_profiles（配置页「全局生效」徽标数据源），恢复后清除；
                             # 恢复分两档——撤销上次写入（UI 名；最近批次，每 tag 轮换留 5 份）与恢复初始状态
                             #   （backups/<agent>/original/ 永久快照，首次 apply 时落、不参与轮换，
                             #   has_original_backup/restore_original_backup）；
                             # codex 轻量注册 codex_register_client_provider：只写 config.toml provider 定义块
                             #   （顶层 model_provider/model 不动、不记 active_global）；认证与「设为全局」
                             #   共用 experimental_bearer_token（ChatGPT 自带 Codex 的 ModelProviderInfo 认这个字段），
                             #   **不写 auth.json**，也不写 http_headers（MCP 字段，写在 provider 上客户端加载失败报 not found）；
                             #   requires_openai_auth = false；写块时清掉旧 env_key / http_headers；
                             #   逆操作只删定义块；codex_client_registered_profiles 供连接页菜单同位状态化；
                             # gemini 双文件：.env 之外必须加写 settings.json 的 selectedType=gemini-api-key
                             #   （v3.147 审计：缺它 gemini ≥0.46 headless auth 报错起不来，JSONC 容错读），
                             #   并登记 modelConfigs.modelDefinitions 让自定义模型进 /model 选择器
                             #   （experimental.dynamicModelConfiguration 开关，requiresRestart，只写不删）；
                             # qwen 条目级 generationConfig.samplingParams（snake_case 线格式，逐模型取值；
                             #   配了就跳过 CLI 的 max_tokens 自动钳制）；
                             # kimi 的 [models.*] 随写 display_name（配置名·模型，选择器 label 优先它）
                             # 与 capabilities（补集写入：恒含 tool_use，保留缺省里未被声明为假的成员；
                             #   未确知不猜——完备声明语义见 conventions/profiles.md 硬规则）；
                             # grok（2026-09-01 起）写 ~/.grok/config.toml：顶层 api_key + [endpoints].models_base_url +
                             #   [models].default 与请求策略全局默认（通用键只设不删，防误清用户手写值）；
                             #   每个绑定模型写 [model.<id>]（name；段键自动加引号）；有「API 后端」或
                             #   权威层上下文再写 api_backend/context_window——api_backend 在 Mesa 侧的唯一通道
                             #   （overlay 白名单不放行 [model.*]）。同段补推理菜单（1.0.40）：
                             #   supports_reasoning_effort + reasoning_efforts（value/label/description，
                             #   四档对齐内置 grok-4.6；已有菜单不覆盖）。中转目录把模型标成
                             #   supports_reasoning_effort=false 时改回 true，否则菜单写了也不出。
                             #   中转目录不带 reasoning_efforts 时不写这段则 /effort 不出
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox、
                             #   槽位专属绑定（task_bindings 列：reader=沉浸阅读对话，set/get_project_agent_binding；删连接时连带清理）、
                             # 稳定项目身份（档案卡顶层 `id` 跟随文件夹；register_at 同一 id 新路径 = 移动重连
                             # 改路径不建新行；write_config_at 保证卡片带 id；list 回填旧行）、
                             # update_step_skills（步骤推荐技能读-改-原子写）、append_pipeline_steps（从模板追加：重名跳过、全跳过不落盘、
                             # 追加成功自动清 pipeline_opt_out）、set_pipeline_opt_out（「不使用研究流程」显式标记读-改-原子写）、
                             # 任务书草稿（read_task_draft/append_step_draft，
                             # .ccode/drafts/）、旧简报一次性并入草稿（list_legacy_briefs）、
                             # 任务卡 kind（idea/draft，旧卡按 step 推断）、fuse_card_into_draft（想法卡会话 ×
                             # 当前步骤草稿 → AI 融合稿，出站 redact_and_cap 不写盘）+ write_task_draft（确认后整份落盘）、
                             # update_lit_watch_filter（雷达筛选读-改-原子写，全空归一 None）、
                             # 验收接受账本（.ccode/acceptance-log.jsonl append-only，按 run_id 去重幂等；
                             #   目标页只读展示最近若干条；task_list 默认不含归档，task_unarchive 恢复）
                             # project-status.json 只是其「最近摘要」投影；目标删除不动账本与摘要）、
                             # 项目移除三档（移除注册 / purge_project_traces 清除 Mesa 痕迹保留文件夹 / delete_project_dir）；
                             # 2026-10-13 双台账：科研 .gitignore 模板直带积累台账面（reading-list/inbox/watch-seen/
                             # watch-followup/watch-explains/pending-registrations/acceptance-log×2/.ccode/watch/）；
                             # 迁移命令曾实现后按「未发布无用即删」移除（存量已手工迁完，重建序列见 pipeline.md）
  project_memory.rs          # 项目知识 .ccode/memory.md：结构化块只记人工确认（revision 比对 + active/superseded/revoked 状态机；
                             # 作废/替代条目不注入，Agent 结论不自动采纳；原文历史保留并留备份）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用；
                             #   开 PTY 用前端传入的 cols/rows（缺省 24×80），避免 resume 先窄后宽把旧帧留进滚动记录；
                             # terminal_link_target = 终端相对路径点击的终审（cwd 拼 + ~ 展开 + 存在性）；
                             # pty_report_terminal_colors = Windows 底色告知（win32-input-mode 记录逐条投递，
                             #   条间 2ms；ConPTY 双向吞 OSC 的实测结论见 conventions/terminal.md，别改回 OSC）
  pty_input.rs               # 每个终端独立的有界输入队列：一个不读 stdin 的 CLI 不得占住 PTY 全局锁
  terminal_replay.rs         # 终端画面回放：<config>/ccode/terminal-replay/replay-<标签>.txt，
                             # 单份 256KB、出站先 redact_sensitive_text、0600；重启占位标签读回，不是会话档案；
                             # prune_terminal_replays 启动后只留当前标签集合（清崩溃残留孤儿）
  clipboard.rs               # 剪贴板图片落盘（save_clipboard_image）：<config>/ccode/tmp/paste-* 白名单扩展名 +
                             # 50MB 上限 + 每次顺带清理 7 天前残留（机制约定见 conventions/terminal.md「输入侧」）；
                             # read_clipboard_files = 文件管理器复制文件的粘贴（mac NSPasteboard / win CF_HDROP / linux 空）
  sessions.rs                # 会话浏览：九 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）、
                             # codex rollout 元信息 model_provider 记进 SessionMetaDto.provider（恢复按它挑兼容 profile，
                             #   前端 pickResumeProfile 单一出处：ccode 或 ccode-<短id> 前缀按网关挑绑定）、
                             # sessions_for_card（融合进任务书的按卡取会话：与列表同一归属口径）；
                             # 无头 AI 按 session id 标 session_meta.internal（雷达解读/定时巡检不进本项目会话，
                             # 禁止把项目路径写入 usage_provenance.internal）
  session_search.rs          # 会话正文搜索：多关键词按「命中多少 + 落在哪」打分、同分按更新时间；正文不进前端
  session_transfer.rs        # 会话包导出/导入（.ccode-sessions.zip，八家不含 opencode）：原文打包装、导入时改写 cwd 并按 B 机
                             #   目录重建落位；zip-slip/大小/后缀/白名单；同 id 跳过不覆盖；Mesa 元数据写 app.db；
                             #   kimi 新版 wd_<basename>_<sha256[:12]> + session_index.jsonl；grok URL 编码 cwd
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor/grok 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content；provides 解析（frontmatter 闭集位声明，
                             #   compose_skill_md 重写链保留——曾在这里剥过字段）；「AI 优化另存」两阶段命令
                             #   （optimize_skills_draft 多源合成出稿不写盘 + create_user_skill 权威名落库带 derivedFrom 溯源）；
                             #   apps 表是创建时快照，
                             #   list 时现算补齐注册表新 agent 的缺键（否则一键应用永远漏新 agent，不写盘）；
                             #   contentDigest = 库目录清单哈希（与漂移检测同口径），项目上下文/执行快照按它记技能版本；内置技能种子（seed_builtin_skills：
                             # include_str! 内嵌 src-tauri/resources/skills/ 18 个技能，启动幂等播种，不覆盖/不复活用户改动；
                             #   删除内置技能先落逐技能墓碑 .builtin-skill-tombstones（删除失败也不留「删了没记」），
                             #   种子版本升级补播跳过墓碑项——墓碑机制前的老删除靠 skill-backups 同名备份回填墓碑）、
                             # 内置技能更新（check_builtin_skill_updates 种子逐字节比对 + apply_builtin_skill_update
                             # 覆盖前备份 SKILL.md.bak-<yyyymmdd> 后原子写入；quarto-render 随包 ieee.csl）、技能接口契约（frontmatter inputs/outputs
                             # 解析进 SkillDto，list 时现算；外部技能未声明时 infer_interface_from_body 正文推断兜底、
                             #   打 interface_inferred 标不回写；前端 skill-conflicts.ts 判定产物冲突 + 跨步骤链路
                             #   （skillChainWarnings：inputs 找供给/outputs 对账预期产物）+ StepSkillsChips 警告行）；
                             # ◈ 适配到流水线（adapt_skill_to_pipeline 出稿 FN_DISTILL + build_adapt_prompt 规范路径表
                             #   单一出处 → write_skill_md 确认落盘，name 强制沿用库中条目；update_content_impl
                             #   interface=None 时保留已声明 inputs/outputs 不静默丢弃）；
                             # 技能内容红线（2026-08-20 社区对标批量升级后确立）：单文件轻量规范（~100 行内，禁脚本/JSON 中间件/lint 体系）、
                             #   产出文件名与流水线接口（TASK.md 内联口径）不动、升级后同步 cp 进技能库（种子改完库不追平，见种子更新机制）；
                             # 删除保护（2026-09-03）：来源口径 = source 字段单一出处（builtin/ccode/local/zip/github/discovered，
                             #   ccode 为 create_skill 后加，旧自建记 local 无法区分、前端 fail-safe 按非自建提示）；
                             #   删除弹层（SkillsPage DeleteSkillModal）列影响面 + 内置不复活警告 + 导入来源，
                             #   delete_impl 先备份库目录进 skill-backups（留 5 份）再卸载；纯逻辑在 src/skill-delete.ts
                             #   （tests/skill-delete.test.ts）
  mcp_blender.rs             # Blender 官方 MCP 本机安装探测（只读：Blender 版本/插件文件/uv/仓库/TCP 9876）
  mcp.rs                     # MCP 清单与分发（§6.15，规格 matrix §10）：统一模型→八家映射（grok 只读）、读-改-写一个键/段 + 备份 +
                             # 原子写 + 读回校验、JSONC 容错读、密钥引用转写（不落明文；引用值可存 mcp-keys.json，启动/体检注入）、stdio 裸命令名 resolve_binary
                             #   绝对化 + node shim 深化、相对路径命令拒写（跨 agent 必挂，报错引导改绝对路径）；
                             #   全局启用开关（enabled 字段：停用=移除各 agent 条目但保留 apps 映射，重开按原样重投；
                             #   停用期间编辑/拨开单 agent 开关只更新清单记意图，不动 agent 配置）+
                             #   连通性检测 check_mcp_server（stdio 拉起 initialize 握手 / remote POST 探活，每次尝试 8s 上限；
                             #   stdio 帧格式自适应：先发规范的 NDJSON 换行帧，server 秒退/首帧非法/超时再换
                             #   Content-Length 头帧重试一次，回包读取器两种帧都认；
                             #   env/header 的 $VAR 引用检测时先查 mcp-keys.json 再查宿主环境（scan_env_refs 整值+内嵌同口径）；
                             #   结果带 status 细分闭集 handshake/reachable/auth/not_found/error——401/403/404 判失败）；
                             #   明文密钥安全闸（审计收口 2026-09-08）：保存/粘贴导入/分发一律拒绝，只接受 $VAR 引用，
                             #   历史明文条目不删不崩但编辑/分发被拦至改成引用，移除方向不拦；
                             #   重命名受保护迁移（新名写好后移除各 agent 旧名条目）；
                             #   codex stdio env 改名引用（TARGET=${SOURCE}）明确拒写；
                             #   origin 来源标记（ccode/imported:<agent>/imported:json，空串=未知按收编对待；
                             #   收编条目删除默认仅从清单移除 keep_agent_configs，不动 agent 配置）；
                             #   外部状态同步 mcp_distribution_status 五态（off/ok/modified/missing/disabled_externally，只读、
                             #   探测失败按 ok 不报警；disabled_externally 仅 codex/grok 的 enabled 键与 codebuddy
                             #   disabledMcpServers 三家实证产出，codebuddy 分发/移除时顺带自清名单本条目）；
                             #   批量体检 check_all_mcp_servers（分波并发每波 4 个、一次性返回）+ 结果沉淀 last_check
                             #   （读-改-写只动该字段、编辑保留旧值）+ stdio 启动超时 startup_timeout_ms
                             #   （clamp 8s–30s 只被体检消费，收编 codex/grok startup_timeout_sec 带入）+
                             #   $VAR 预检 mcp_missing_env_refs（只读，前端保存/分发前非阻断警告）；
                             #   相对路径命令（./ ../ 开头）先解后拦（resolve_relative_candidates：基准序 = 条目绝对
                             #   cwd → 来源 agent 配置家目录 → 实证插件目录（仅 codex computer-use/plugins），收编/导入
                             #   命中存绝对路径 + cwd 规范化、不命中 fail-open 收进清单，分发试解失败才拒写）+
                             #   命令路径探测 mcp_command_path_status（ok/relative/missing 闭集，$VAR 引用不判）+
                             #   resolve_mcp_command_fix 一键修复候选（origin 推断来源 agent）
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径、
                             # rebuild_locked 进程互斥（DELETE→upsert 非事务，并发双跑会 ON CONFLICT 累加翻倍，
                             #   四个调用点 session_usage/rebuild_usage_index/get_usage_stats 首跑/usage_activity 全走它）；
                             # usage_activity 活跃度热力图：全历史非零日序列（day×agent×model 聚合 +
                             #   day×model 走 Bucket::cost 计价），先增量 rebuild 再查询、失败 stale=true 回落；
                             #   二期：usage_day_detail 单日明细（总量+按 agent 分解+会话列表，internal 沉底、
                             #   标题过 redact_sensitive_text，不触发 rebuild）+ usage_activity_agents
                             #   年矩阵（day×agent 四类合计，胶囊筛选用）；
                             # session_usage 单会话聚合（终端状态栏 token 段，先增量索引再按 session_id 汇总）；
                             # usage_trend / top_sessions：花费折线与最贵会话均跟随页顶范围，官方账号与 internal 不计费不进榜，
                             # 自定义标题出站前过 redact_sensitive_text；总额卡与折线/榜单同一计费范围，
                             # 官方/internal 的 token 量单列展示不计费（v3.255）；
                             # provenance v7 起按会话级登记（official 用启动 hint/恢复目标写 session_id 行，
                             #   启动时不知 id 的 agent 由重建索引按 session_meta.profile_id 解析认证方式兜底；
                             #   旧项目级行只回填 created_at 之前已存在的会话，不粘住新会话）；
                             #   session_meta.internal（无头 AI/定时巡检按会话 id 登记）纳入用量索引；
                             # 定价链 PriceChain 三层：用户 pricing.json > 公共能力库 cost > 内置表 BUILTIN_PRICING
                             #   （高层任意前缀命中即胜、同层最长前缀优先——用户写短前缀即覆盖低层细分代；
                             #   内置表口径 2026-08-31 各官方页，跨代改价给新代加更长前缀、旧价留给老会话归属）
  subscription_quota.rs      # 订阅余量查询（用量页「订阅余量」卡，多供应商一张卡可切换，2026-09-19）：
                             #   智谱 / Kimi For Coding / MiniMax 三家（火山方舟未接——控制面 OpenAPI 需 IAM AK/SK
                             #   签名，与网关单密钥模型不符，待网关加 AK/SK 字段后单批做）。
                             #   智谱额度 GET /api/monitor/usage/quota/limit（limits[] type∈TOKENS_LIMIT|CREDIT_LIMIT、
                             #   unit 3=5h/6=周锚定禁按重置时间排序、percentage=已用；cc-switch/CodingPlanQuota 口径）+
                             #   重置卡 GET|POST /api/biz/customer-package-reset/{list,use}（OmniRoute 口径：信封
                             #   success+code∈{0,200} fail-closed、双桶截断不当 0 张、code 1001=密钥失效、
                             #   卡条目多别名 + status consumed/redeemed/… 不可用 + 无时区时间戳分区域：bigmodel.cn 北京时间 +8（用户官网比对实测修正）、z.ai UTC；
                             #   DTO 暴露每类最早过期时间（临期提示 + use 优先消费最早过期的卡））；
                             #   Kimi GET api.kimi.com/coding/v1/usages（limits[] 多模型 5h 窗取 utilization 最紧、
                             #   usage=周窗、used=limit-remaining）；MiniMax GET /v1/api/openplatform/coding_plan/remains
                             #   （general 条目、字段是剩余百分比要反转、周桶仅 current_weekly_status==1）；
                             #   窗口 DTO 除 used_percent/resets_at 外另有 used/total 绝对值（2026-09-21）：
                             #   智谱 limits[].currentValue/usage 就是已用/总量积分（实测周窗 140023/140000 超发
                             #   如实透传不在解析层钳），Kimi limit/remaining 是配额点数，MiniMax 只回百分比 → None；
                             #   **只有字段真的给了才带**（缺 limit 不拿兜底 1.0 当总量），前端两个都有值才显示；
                             #   parse_zhipu_quota 用 PlanWindow 直接装中间态——它自带 window 字段，
                             #   归周窗时**必须改窗名**（旧版是 push 时才贴标签，漏改会让两根条都写「5 小时」）；
                             #   智谱 5h 窗实测不回 nextResetTime → 认 None 不编时间；
                             #   重置卡仅智谱支持（DTO reset_cards_supported，其余家不渲染该行）；
                             #   团队版 = 网关 headerEnv 带 bigmodel-organization/project 隐式识别（?type=2 + 两头）；
                             #   Bearer 鉴权（裸 key 亦通，智谱两者都认）；密钥只在 Rust 层出 keys.json 绝不进 DTO；
                             #   用卡（plan_use_reset_card）是消费性写操作——显式命令 + 前端确认弹窗，成功作废缓存；
                             #   2 分钟进程内缓存（对齐用量页可见期自动轮询，页面不可见即停）+ 瞬时失败回落上次成功值
                             #   标 fromCache；无后台轮询；不注出网代理；
                             #   复用 reqwest Client（连接池，勿退回每请求新建 Client = 每次重新握手）；
                             #   plan_quota_overview 多网关并发（spawn 全部再按序收），等待 ≈ 最慢一家不是相加
  gateway_balance.rs         # 网关余额查询（用量页「网关余额」卡，与订阅余量并列，2026-09-20）：
                             #   New API 兼容预付钱包，出卡零配置（槽 URL 主机命中 zetatechs.com 即出；加站点 = WALLET_HOSTS 加一条）；
                             #   公开 GET {origin}/api/status 取 quota_display_type / quota_per_unit；
                             #   钱包优先：keys.json `{id}#wallet` 系统访问令牌（cc-switch PAT，不是推理 sk-）打
                             #   GET {origin}/api/user/self，带 New-Api-User 等兼容头（all-api-hub 口径）；
                             #   无令牌再试推理密钥（多数站 401 不当成密钥失效）→ /api/usage/token/ → billing；
                             #   source=wallet|token；不限额度且无钱包数字时改口去网关库填令牌；
                             #   DTO 带 account（/api/user/self 的 display_name→username，**绝不取 email**）与
                             #   token_name（/api/usage/token 的 name）：account 是前端「同站合并成一张卡」的分组键，
                             #   同站两个账户必须分成两张卡，拆掉它就会把两个账户的余额混一张；
                             #   「去钱包」={origin}/wallet；密钥只出 keys.json 不进 DTO；2 分钟缓存 + 瞬时失败回落；
                             #   不注出网代理；不做 usage script / 探测全部网关
                             #   **等待结构（2026-09-21 用户实测「刷新很慢、不如智谱那个快」后重做，勿退回）**：
                             #   多网关并发 spawn 再按序收（三网关顺序 ≈2.1s → 并发 ≈0.66s，本机实测中位）；
                             #   /api/status 按 origin 进程缓存 10 分钟（同源多网关只打一次，失败回落旧值再回落内置默认）；
                             #   「密钥额度」端点写尾斜杠 /api/usage/token/——不带斜杠该站 301，跟一跳白多一个 RTT；
                             #   改等待结构前先量单请求 TTFB（本机 status ≈1.0–1.5s / self ≈0.8s / token ≈0.7–2.0s），
                             #   慢的是串行 × 网关数，不是某一路慢
  pricing.rs                 # pricing.json 读写与校验（定价链最高层，原子写）
  about.rs                   # 「关于」分区后端：read_third_party_notices（include_str! 嵌随包许可清单）+ build_info（平台/架构/渠道）；清单由 scripts/gen-third-party-notices.mjs 生成，改依赖后必须 npm run gen:notices 再提交
  feedback.rs                # 反馈通道后端：FEEDBACK_ENDPOINT 常量（None=mailto 回落，公司端点上线改这一行）+ submit_feedback（POST JSON，15s 超时，表单+环境行+截图 Base64）+ save_feedback_images（邮件通道截图落盘 Downloads/ccode-exports/mesa-feedback-<时间>/）+ 邮箱直发（send_feedback_smtp：lettre+rustls，截图真实附件；授权码经 profiles::set_shared_key 存 keys.json 键 feedback-smtp，0600 持锁；配置存 settings feedbackSmtp）。端点启用前需验证 8MB 级 JSON 的 IPC 与超时
  settings.rs                # 应用设置（settings.json）：字体/scrollback/渲染器（terminal_renderer：auto/dom/webgl，Mac 默认清晰、Windows 默认流畅，读时闭集过滤）/汇率/镜像/主题/OS 通知/精确注意力
                             # （hooks_attention 按 agent map，旧 claude_hooks_attention 仅反序列化兼容迁移）/想法期只读保护
                             # /会话自动命名开关（auto_title_sessions 默认开，关 = ai.rs 起名/补名命令全停；
                             #   闸门读 auto_title_sessions_enabled）
                             # /底部状态栏统一开关（status_bar 默认开，终端/聊天两层同进退；关 = 都不渲染，
                             #   切层不改终端行列数，invisible 占位机制退役；旧 status_bar_in_chat=false 读时迁移为关）；
                             # terminal_color_report 默认开（Windows：ConPTY 吞掉 OSC 底色查询，浅色主题下
                             # 主动把前景/底色推给 gemini/qwen；白名单外的 agent 推了会变输入框乱码，
                             # 见 docs/conventions/terminal.md）；
                             # hidden_profiles = 软停用（自动路径跳过、手动可用；v3.142 起不再是纯展示偏好）；
                             # active_global_profiles = 「设为全局」追踪（agent→profile id，record/clear_active_global
                             # 维护、不走 patch、clear_profile_refs 同步清引用；只代表「上次由 Mesa 写入」非绝对生效态）；
                             # outbound_proxy = 出网代理（注入官方账号启动与组头登录；2026-09-19 起下载侧同源注入——
                             #   agent 安装/更新、依赖安装、字体下载走 download_proxy_env（大小写成对，curl 只认小写 http_proxy），
                             #   更新检查的 npm view/brew info 同注；国内镜像主机（TUNA/南大 ghcr）并入 NO_PROXY 直连不绕代理；
                             #   用户环境已带任一代理变量时不覆盖。网关启动仍不走；extra_env 同名键覆盖；校验 http(s)/socks5，空串清除）
  hooks.rs                   # 精确注意力标记（七家 hooks 桥接）：BRIDGE_SPECS 每 agent 一张桥接规格（claude/qwen/
                             # codebuddy/gemini/kimi/grok/codex；cursor 无「等待确认」等价事件、opencode 无 shell hooks
                             #   形态，两家未接入），写各家 hooks 配置（备份留 10 份 + 原子写 + marker 合并/移除 +
                             #   损坏拒写；grok 整文件归 Mesa、外来文件拒覆盖），机制调研录 matrix §12；
                             # 事件日志解析双信封（snake_case/camelCase）+ 事件名去下划线小写归一 + grok Stop 只认
                             #   reason=end_turn + 会话归属双键匹配（session_id==文件主名 或 transcript_path==完整路径），
                             #   10 分钟 TTL 回落尾部推断不变；settings 字段 hooks_attention: map<agent,bool>
                             #   （旧 claude_hooks_attention 仅保留反序列化兼容迁移）；
                             #   session_confirm_detail（2026-08-24）：confirm 时从 payload 提取「在等什么」摘要
                             #   （message/tool_name/title 尽力而为），聊天层审批卡片用
  inst_access.rs             # 机构访问通道（2026-09-16）：人登录一次、系统复用会话——登录窗（Tauri WebviewWindow
                             #   label=inst-login）Cookie 落 0600 inst-session.json（值绝不出站，状态 DTO 只有
                             #   域名/条数/时间）；EZproxy/OpenAthens 前缀 ?url= 改写（settings institutional_prefix，
                             #   书签式前缀自动剥尾部 url=）；DOI→合法开放副本查证（Unpaywall best_oa_location
                             #   .url_for_pdf 优先、OpenAlex 回落）；落地页 citation_pdf_url meta + 常见 PDF 链接
                             #   形态提取；fetch_via_session 手动逐跳跟重定向（每跳按 host 重算 Cookie 头）。
                             #   硬边界：不存机构账号密码/不做无人值守自动登录；scheduler/无头不携带会话；
                             #   只由人 UI 逐篇触发（lit_watch::fetch_paper_fulltext 阶梯调用），不做批量。
                             #   登录窗轮询走独立线程（Windows cookie API 在主线程同步调用会死锁）。
                             #   窗内 PDF 落盘走**单一下载漏斗**（2026-09-16 终局，勿再加拦截层/页→本机回传）：
                             #   builder 注册 on_download（Requested 把落点改写 <config>/ccode/tmp/inst-dl/、
                             #   Finished 按 url→落点 map 对账读文件 → %PDF- 魔数校验 → 多槽暂存（唯一文件名，
                             #   inst-pdf-relayed → App 层 inst_save_relayed_pdf 落 papers/）；页侧 LOGIN_INIT_SCRIPT
                             #   常驻 ⤓ 胶囊（2s 周期重检直链）+ __mesaGrab（a[download] 按钮 → 合成
                             #   a[download] 走 WKDownload → fetch 魔数校验）；点 /doi/pdf/ 拦住改保存
                             #   （WKWebView 内联 PDF 无保存入口）；/doi/epdf/ 放行（Wiley/ACS 阅读页）；
                             #   直链存成网页则改开阅读页。on_navigation 拦 pdfish 后 Rust 用窗口会话直拉（绕过
                             #   页内 CORS，MDPI 的 mdpi-res.com 等 CDN），失败再回落页侧 grab；about:blank
                             #   document-start 刷浅底防开窗黑屏。wry：download 属性走下载委托、application/pdf
                             #   主框架导航被内联渲染——结论记 pipeline.md「机构访问通道」。
                             #   ScienceDirect（2026-09-16 晚）：不放 citation_pdf_url、PDF 链接是 PII 路径不含
                             #   DOI（通用探测两条路全落空）、View PDF 是 JS 弹层按钮——mesaSdPdfUrl 三级
                             #   （#pdfLink href → 内嵌 JSON pdfDownload.urlMetadata token 直链 → 按 PII 构造
                             #   /pdfft?download=true）；**SD 终局（三形态实测 + wry 源码）**：下载式请求
                             #   （a[download]/WKDownload action）被回 HTML、普通导航被 wry 内联渲染白屏
                             #   （wry navigation_policy_response 只看 canShowMIMEType、无视 Content-Disposition）、
                             #   blob 下载 Finished 挂起——唯一通道 = 页内 fetch 取字节 + mesaChunkRelay
                             #   分片回传（块长 61440=3 的倍数——65536 时非末块 btoa 自带 == 填充、拼接
                             #   解码必挂；先 mesa-chunk://b/{total} begin 握手、Rust 只收握手后 60s 内
                             #   块数吻合的分片，逐块解码；mesa-chunk://c/{seq}/{total}/{b64} 合成锚点导航，
                             #   Rust on_navigation 收片取消导航，不受 CSP/混合内容限制；收齐解码校验走既有
                             #   inst-pdf-relayed 入库链；Zotero Connector 页内取字节带外送回的 webview 等价物）；
                             #   胶囊创建即上文案（空胶囊=黑圈）；View PDF 命中后 closest('a[href]') 沿祖先找
                             #   href、未检出直链 1.5s 宽限重测。SD 交互终态（用户拍板「进 View PDF 再下载」）：
                             #   SD 页面不拦 View PDF（mesaIsSdPage）、grab 不点站方下载控件——让站方阅读器
                             #   打开，mesaPdfUrl 内嵌扫描（iframe/object/embed）取 PDF 地址走分片回传。
                             #   页侧通用分型层（同日深夜，按清单出版商收口，只加失败救援不动已通路）：
                             #   mesaVerifiedGrab 验证式抓取（同源 pdfish 先 fetch 验明正身，验明后对真实 URL
                             #   合成 a[download] 走 WKDownload——**禁 blob→a[download] 落盘**：macOS 上
                             #   Requested 后 Finished 挂死（20:33 实测），__mesaDownloading 有 90s 看门狗；
                             #   HTML 中间页由 mesaIntermediaryNext 解析 meta refresh/redirect-message/
                             #   iframe·embed·object 内嵌 pdfish 再取，≤3 跳；Wiley/ACS 型 /doi/pdf/ 经
                             #   mesaViewerUrl 非空跳过）；mesaPdfUrl 第二遍单链采用（RSC articlepdf 只带
                             #   DOI 后缀/IEEE arnumber 不含 DOI 前缀——文章页全页唯一 PDF 链才用）；
                             #   Rust got-html 回救 __mesaGrabVerified（拿到网页时页侧解析重试，Wiley 型仍走 epdf）。
                             #   出版商分型纪律（用户指令，勿顾此失彼）：每家期刊 PDF 供给形态不同（已实证
                             #   通用meta/DOI内链/Wiley-epdf/MDPI-CDN直拉/编号链(RSC·IEEE)/中间页(SD·IEEE)/
                             #   SD复合/签名直链八型），为一家修问题只动该家命中的最窄分支、禁改通用路径，
                             #   收尾逐一回归各型——细则见 pipeline.md「机构访问通道」⑦。
                             #   收货通道 A/B/C（同日深夜用户定稿「让真实浏览器干浏览器的事」，Mesa 只收货）：
                             #   A download_inbox.rs 监听系统下载目录 + Chrome/Edge/Firefox 自定义默认下载目录收 PDF（inst_browser_open 调起系统浏览器
                             #   + 登记归属，六层过滤链收货进既有入库链——高置信命中收完进回收站、
                             #   兜底关联（文件名没对上号）原件留在下载夹并弹 inst-pdf-attention 横幅；
                             #   终端只印启动/失败/收货结果，不去重跳过刷屏——macOS 一次落盘连发多条
                             #   FSEvent）；B 浏览器会话复用
                             #   （设置页「学校图书馆」主路径「登录学校账号」，内嵌窗留回落）；C extension/（MV3，ID 固定
                             #   dmjplopfhbdamkihimfllomdmkfainnn）+ bin/mesa_helper.rs（native messaging，读 helper-context.json
                             #   当前项目+打开篇标题/DOI 调 ccode_lib::helper_ingest；PDF 阅读器空标题不得落 paper-5.pdf；
                             #   工具栏图标优先走页内「存到 Mesa」，chrome.downloads 只作无 content script 末路）
                             #   + browser_bridge.rs（装 NativeMessagingHosts
                             #   清单）。内嵌窗漏斗保留为过渡，通道 C 稳定后退役——细则见 pipeline.md ⑧
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议/提炼接力简报/评审沉淀起草（只写下一步还没有的约束，无新约束返回空）；
                             # resolve_profile_from 最近使用回落跳过官方账号（OAuth 过期会甩 CLI 日志；显式/专用仍尊重）；
                             # 失败走 summarize_headless_error，不把 stderr 整段回给前端；401 invalid_api_key 按
                             #   「报错 URL host × 绑定 base_url host」细分：发去 api.openai.com 而配置是网关 = 渠道路由错
                             #   （引导重设全局默认），网关自己拒 = 密钥错（引导重填），该判定必须先于 401+unauthorized
                             #   归官方账号失效的笼统分支；
                             # headless_task_args/run_agent_task 供 scheduler 复用（定时任务要写项目文件，codex 用 -s workspace-write）；
                             # 会话自动命名（ai_auto_title_session early/final + ai_retitle_all_sessions 补名去重）：
                             #   settings::auto_title_sessions_enabled 关 = 两命令入口直接跳过（最终闸门在此，前端跳过只为省白跑），
                             #   补名批循环逐轮复查闸门（中途关掉即停）；retitle impl 闸门收进参数是关停语义的单测锚点
  scheduler.rs               # 定时雷达（v3.75；v3.79 起技能可选；v3.218 新建巡检技能：草稿 .ccode/drafts/watch-*，确认才入库分发）：
                             # schedules.json（每日/每周+时分，本地时区）、60s tick + 启动补跑
                             # （漏跑 coalesce 只补一次）、无头拉起 agent 在任务隔离 worktree 跑技能（先从主仓播种订阅/台账；项目根只用于归属与采纳；非 Git 项目明确失败；显式 sentinel 才允许主仓写入；人点「采纳进项目」才拷产出——2026-10-13 起：采纳前按评审「排除」决定剔除条目（watch_review::drop_excluded_from_snapshot）、已采纳记录明确拒绝重采纳（find_run_record）、run_marked_adopted 是 decide 的后端闸门；历史行可删（schedule_run_delete：账行/事件/历史行/冻结证据），删任务/移项目必级联（purge_schedule_side_effects，worktree 走回收站）；默认 lit-watch，prompt 按技能分派（lit-watch 文案明锁不写 included/index/references.bib）：
                             # lit-watch 专用文案不动、其他技能通用模板，非 lit-watch 跑前检查已分发，30 分钟超时（2026-10-03 由 600s 提高））、
                             # 历史留 20 条、跑完发 scheduler-run-done 事件（App.tsx 全局监听弹 OS 通知，复用长任务通知开关）；
                             # RunRecord.newEntries 新命中计数；2026-09-29 起界面不再写关联步骤，保存时清掉旧 linkedStep
                             # （跑 lit-watch 前后数 inbox.md `## ` 标题数取差，超时/失败不记；项目配了雷达筛选时
                             # 前后各数一次过滤后条目取差，推送/收件箱胶囊只算符合筛选的）
  lit_watch.rs               # 文献雷达应用层（v3.95）：巡检产物解析 DTO（notes/inbox.md 有效文献块含 watch-run 批次标记日期、上限 500 条；
                             # 漏写批次时 stamp_undated_inbox 只插入标记行：冻结前按本次完成日、打开雷达时按最近已采纳成功巡检；
                             # repair_watch_batch_dates 供空态「按巡检日补记」，已有任一条带日期则不写；
                             # papers/watch-followup.md 付费墙待办、watchlist.md 订阅读写整表写回保留注释行、included.md 精读清单
                             # 增删去重）+ download_paper_pdf 白名单下载（仅 http/https、60MB 流式上限、%PDF- 魔数校验、
                             # adopt_watch_pdfs：采纳时把隔离树 papers/ 里主仓没有的 %PDF- 拷进项目根并登记，同名不覆盖；
                             # drop_inbox_entries：采纳过滤用，按行范围整段删被排除条目并清悬空批次标记；
                             # 落 papers/ 自动登记 project.toml 资源）+ attach_paper_pdf 关联本地 PDF（付费墙手动下载后
                             # 一步复制进 papers/ 并登记，源文件同口径校验、复制非移动）；门槛 = 注册项目根 + canonicalize + 读-改-原子写；
                             # 雷达筛选判定 metrics_pass_filter / count_inbox_entries_matching（scheduler 推送计数用，
                             # 口径见 conventions/pipeline.md「雷达筛选」）；
                             # 快筛解读落 `.ccode/watch-explains.json`（规范化标题去重，list 出口挂 WatchEntryDto.explain，
                             # 不写 inbox.md）；2026-10-13 双台账：papers/reading-list.md 积累账（list/add/remove_reading_list_entry，
                             # 行格式与 included.md 同构、去重域=两账并集）+ freeze_reading_list_intake 开工冻结为工作区
                             # .ccode/handoff-lit-intake.md（best-effort、agent 读定格副本不回写活文件）+ PDF 资源登记相位感知
                             # （register_pdf 遇 active/creating 工作区不写 project.toml，改记 .ccode/pending-registrations.json
                             # 按 path 覆盖去重；replay_pending_registrations 在项目打开/工作区归档时回放登记）
  journal_metrics.rs         # 期刊指标表（雷达徽章数据源）：config_dir/ccode/journal-metrics/ 下 JCR2025-UTF8.csv +
                             # FQBJCR2025-UTF8.csv（来源 github.com/hitfyd/ShowJCR，用户本机下载、禁内置分发）合并成
                             # HashMap（normalize_title 规范化精确匹配，miss 时剥末尾出版商括号尾巴（「(Wiley)」「（ACS）」可多级）
                             # 重试，仍 miss = None 不虚构；前端 lit-watch.ts sourceDisplayName 同口径剥尾，两处同步），RwLock 进程内缓存；
                             # list_watch_entries 出口 enrichment 进 WatchEntryDto.metrics（展示时现算不落 inbox.md，
                             # 旧条目装表即生效）；lookup_journal_metrics 给检索清单按刊名优先、ISSN 兜底批量现查（不写项目文件）；
                             # download_journal_metrics（jsDelivr→raw 回落、.tmp 原子落盘、完清缓存）+
                             # journal_metrics_status（含 downloadedAt：两份 CSV 取较新 mtime）+ check_journal_metrics_update
                             # （GitHub commits API 按数据目录查最近 commit，与本地 mtime 比对出 hasUpdate，前端静默失败）
  research_quality.rs        # 科研复现运行记录与验收决定：独立输出 ~/ccode/reproductions/；验收写 .ccode/research-acceptance.json，不替代 Git 合并
  endnote.rs                 # EndNote 出库：references.bib 经 endnote-bridge/scripts/bridge.py 生成
                             # library_match.py：定稿域稿只读本机 .enl / zotero.sqlite，DOI 唯一才写入记录号或条目地址
                             # papers/endnote-import.xml、.ris、.enw。RIS 作者一人一行，期刊/缩写/卷/期/页/日期/ISSN/摘要/关键词
                             # 随 bib 字段写入；没有的不编造。按钮「同步到 EndNote」把 RIS 放到下载并 open -a 交给 EndNote。
  research_tools.rs          # 科研外部工具开工 preflight（research_tool_preflight）：Zotero 本地通道 / Origin 平台门槛
                             #   （只做 Windows 实机，非 Windows 必需技能=阻塞）/ Blender 探测 / EndNote 桥；
                             #   只探测，不安装、不写个人库、不启动 GUI
  reader.rs                  # 沉浸阅读区后端（v3.96）：ensure_paper_note 建档 notes/<slug>.md（精读八小节对齐 lit-notes 技能口径 + 机管「译段」「我的想法」两节，已存在不覆盖；
                             # 建档前先扫 notes/ 头部「来源行」配对已有精读笔记，命中即复用不另建，空模板 slug 笔记顺带清回收站
                             # （锚点相对/绝对都认：agent 实测几乎全写成项目根绝对路径，配对统一解析成 canonical 再比，2026-09-20）；
                             # pdf_for_note 笔记→配对 PDF（来源行锚点优先；无锚点回落笔记 stem ×「type=paper 资源 + papers/ 顶层 PDF」
                             # 做 normalize_title 互相包含（2026-09-20 起 papers/ 直扫：agent 直下全文没走登记通道也能配），多命中取最长，无命中返回 None；lit_watch.rs normalize_title 提 pub(crate) 复用）+
                             # reader_for_note 归属反查版（注册项目根直含 / 工作区 worktree 映射主仓副本，未合并明确报错）+
                             # read_image_bytes 图片通道（png/jpg/jpeg/gif/webp/svg、20MB，白名单判定复用 pdf.rs 内核）+
                             # save_reader_capture 圈选截图落 notes/assets/（PNG 魔数 + 同秒重名 -2/-3）/ append_note_image
                             # （追加进「我的想法」小节）+ 生词本 notes/glossary.md（list/append 术语小写去重/remove）+
                             # append_note_translation（「译段」小节）；门槛 = gated_root 注册项目根 + canonicalize + 原子写
  citation.rs                # 引用健康检查：.md 引用键（[@key]/多键/[-@key]）对照 references.bib（白名单同 pdf.rs 口径）
  handoff.rs                 # 接力（§11.3 机制四）：简报生成（脱敏+64KB）、提炼接力（build_session_digest AI 蒸馏全会话 +
                             # finalize_digest_brief 初稿写回）、handoff_links 接力链登记/固化
  runs.rs                    # 一次干活身份（app.db runs 表）：交互 pty_spawn 必有 id，无头 internal；
                             # 关标签不删行；收件箱 action.run 可恢复；登录标签不建行；
                             # Run 可以没有 Goal（2026-09-09，§4.7）：scratch/reader/办公文件闲聊
                             # task_id 落 NULL，不再 ensure_task_at 强制登记；自动登记只留
                             # pipeline_step/coding_lane/watch（run_needs_task）；
                             # 普通目标开工写评审基线（写失败即开工失败）、收尾触发冻结、
                             # 预览/采纳绑定冻结快照（失败清理只删本次新建目录 cleanup_failed_prepare）
  runs/goal_storage.rs       # 普通目标副本的显式清理：归档、项目成果与接受账本不在删除范围（两步各需确认）
  task_review.rs             # 普通目标评审证据（规格 conventions/review-freeze.md）：开工基线哈希、
                             # 收尾冻结 payload 副本（拒绝改写）、采纳三向判定（项目现读 vs 基线 vs 冻结内容，
                             # 删除永不写回、>64MB 不自动采纳）；纯文件事实不碰数据库，编排在 runs.rs
  review_contract.rs         # 评审契约纯逻辑（本文件禁 git/文件拷贝/merge）：四条写回链 kind 常量（goal_adopt/
                             # pipeline_merge/coding_merge/watch_adopt）、seq/SHA 断言、apply_lock 项目锁、
                             # pending 恢复单（write/read/clear + recover_fact 补账只重放原事实不编造）、
                             # result_readiness 派生可审；2026-10-13 起承载合并闸门台账豁免 is_untracked_ledger_file
                             # （reading-list/watch-explains/pending-registrations 只豁免 ??；notes/*.md（index.json 除外）、
                             # inbox/watch-seen/watch-followup/acceptance-log×2 双态全豁免）——workspaces 合并闸门与
                             # 开工脏文件点名、coding 改动计数、projects 迁移前置四处共用
  custom_runtime.rs          # 自定义 Runtime：用户登记命令，直接在已校验的隔离目录中运行；相对路径拒写；无密钥/会话/MCP；不支持恢复
  coding.rs                  # 编程项目 git 原语：worktree list / 从基准或已有本地·远程分支建树（~/ccode/worktrees）、
                             # origin 身份 + 相对上游 behind、fetch / pull --ff-only / push、合并进基准、
                             # Desktop CLI 打开该树 / gh --web 开 PR（CodingOpDto；不走科研工作区库）；overview 按树/分支并行 git
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml、
                             # 人工事项状态（human_task_checks 勾选 + human_target_hit 落点检测 + human_target_count 命中计数/to-fetch 清单计数——
                             # 计数口径与前端 step-flow.ts parseToFetchItems 双端镜像：编号/列表行都算，裸行须带「 — DOI」尾巴，说明行与「待补」不算）、import_human_deliverable
                             # 交付导入（复制落点 + 登记提货单；v3.74 起 step/title 可选 + target_override 固定落点，
                             # 无步骤语境 = papers/imports/ 检索结果导入落主仓）、list_help_requests（.ccode/help-wanted.md 人工请求扫描）
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引；
                             # MERGE_HEAD → merging + git_abort_merge；porcelain 冲突码归 U
  fs_tree.rs                 # 文件树与文件操作（删除走系统回收站 trash；重要路径删除保护，canonicalize 双校验；
                             # drop_ris_record / drop_fetch_line：移出时整份改写超过 256 KB 的 RIS 与 to-fetch.md
                             #   家目录直下系统目录标 isSystem 供前端置灰）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
  sheet_preview.rs           # Excel/ODS 预览：同一套白名单读字节，calamine 抽指定工作表（200×256）+
                             #   xlsx 合并区（load_merged_regions，裁进窗口）
  storage.rs                 # 本机文件持久化原语：跨进程读改写锁、私有临时文件（0600）、安全替换
  uninstall.rs               # 一键卸载：Mesa 独占目录（配置 ccode/、~/ccode/、本机数据 ccode/、
                             #   com.ccode.dev 的网页数据）移入回收站；浏览器桥清单与 Windows
                             #   注册表键复用 browser_bridge 的目录表。课题文件夹与各 CLI 数据不动
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm、Windows winget 渠道：claude/codex/opencode/kimi/grok 五家有官方包）+ 应用自身 Tauri updater；
                             #   run_streaming_pty/run_streaming/emit_done/winget_args 为 pub(crate)，dep_check 复用同一管线
  watch_review.rs            # 定时巡检产物评审：工作目录可复用，但评审和采纳只读每次执行冻结的副本
                             #   （2026-10-13 起：new_hits_of 评审只列该次新命中=after−initial；watch_run_decide 校验冻结证据并对已采纳运行拒绝；
                             #   决定存隔离树 .ccode/watch-review.json，文件损坏时写入 fail-closed；drop_excluded_from_snapshot 供采纳剔除被排除条目）
                             #   （基线文件 + 技能产出契约，与 task_review.rs 同构不合并）
  dep_check.rs               # 依赖体检 + 一键安装（git/node/quarto/tex/pymupdf/pillow）：check_dependencies（git 三态
                             #   ok/missing/clt_stub，TeX 认 xelatex/tectonic/pdflatex 任一，拼图库问 python 能否导入）
                             #   + install_dependency（quarto 走 brew --cask / winget Posit.Quarto；tex 装 tectonic；
                             #   pymupdf/pillow 走 python -m pip，externally-managed 再加 --user；Linux 只给指引）；
                             #   缺 git 走收件箱 dep: 类别常驻提醒（不造横幅）
  logbuf.rs                  # 诊断日志环形缓冲
  diagnostics.rs             # 诊断包：系统/WebView/GPU/输入法、功能开关、日志、进程生命周期采集与 ZIP 导出
  config_dump.rs             # 生效配置自省（只读，不建/不改任何用户配置文件）：dump_effective_config /
                             # export_effective_config（落 ~/Downloads/ccode-exports/ccode-effective-config-<时间戳>.json）——
                             # 快照含 generatedAt/appVersion/appSettings（with_defaults 完整 DTO）/profiles（仅 keyHint 尾号、
                             # 剔除 extra_env，绝无密钥）/hooksAttention/capabilities（复用 agent_capabilities）/
                             # workspaceSettings（传 root 时 ws_settings 三层合并终值 + 每键来源层标注）；
                             # 整份出站前过 sessions::redact_sensitive_text；设置页「诊断」区「生效配置快照」卡片消费
  process.rs                 # 后台子进程统一创建（Windows CREATE_NO_WINDOW 防 conhost 闪窗）+
                             # pty_command（Windows .cmd/.bat shim 深化：npm 系 CLI 解析出 JS 入口改 node 直启，
                             #   npm.cmd 走固定布局 special case，解析失败回落 cmd /c call；updater 与终端拉起共用）
  models.rs                  # 共享 DTO
  lib.rs                     # 模块与 Tauri command 注册
```
