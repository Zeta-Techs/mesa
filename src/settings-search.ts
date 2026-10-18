/**
 * 设置页的搜索索引。
 *
 * 设置分十档、散在 3000 行里，找一项得先把十个标签挨个点开看。索引收在这里的理由
 * 与判据收在 step-flow 一样：关键词是**给人搜的词**，和人看到的行标签不是一回事——
 * 用户搜「代理」要落到「网络」，搜「卡顿」要落到「外观」的终端渲染，这两个词在标签
 * 里都没有。所以每档除了标签，还记别名。
 *
 * 只做「搜到哪一档」，不做逐行高亮：设置项大多是开关，高亮一半控件比让用户多看一个
 * 分区更费解。搜出来的档直接切过去，再用浏览器原生的页内查找定位具体行。
 */

/** 设置分区 id，与 SettingsPage 的 SETTING_NAV 一一对应（那里是 string，收紧在这里） */
export type SettingSectionId =
  | "appearance"
  | "terminal"
  | "startup"
  | "hotkeys"
  | "stats"
  | "integration"
  | "network"
  | "update"
  | "diag"
  | "storage"
  | "about";

export interface SettingsSearchEntry {
  id: SettingSectionId;
  label: string;
  /** 别名。写用户可能打的词，不写字段名——字段名在界面上不出现，搜它没意义。 */
  aliases: readonly string[];
}

/**
 * 索引。label 与 SETTING_NAV 一致，别名按各档实际内容写：
 * 外观档带主题/透明度/应用图标/状态栏，终端档带渲染/字号/字体/调色板/滚动缓冲/外部终端/运行时，
 * 通用档带启动页/导航形态/通知/顶部岛，AI 与 Agent 档带 AI 配置、会话自动命名、只读保护与注意力标记，
 * 网络档带代理、brew 镜像与文献页登录，数据档带导出与项目目录。
 * 顺序即界面顺序（常用在前、管理在后），无结果时按原序展示。
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  {
    id: "appearance",
    label: "外观",
    aliases: [
      "主题", "深色", "浅色", "暗色", "配色", "颜色", "色卡", "自定义主题", "跟随系统", "自动深浅", "我的配色",
      "状态栏", "底部状态栏",
      "透明度", "磨砂", "毛玻璃", "侧栏透明", "顶栏透明", "玻璃", "透视", "壁纸",
      "应用图标", "图标", "程序坞", "Dock", "任务栏图标", "托盘图标",
      "theme", "appearance", "opacity", "blur", "icon",
    ],
  },
  {
    id: "terminal",
    label: "终端",
    aliases: [
      "字体", "字号", "字体大小", "等宽字体", "终端字体", "终端字号", "终端渲染",
      "渲染器", "画布", "GPU", "序列化", "性能", "卡顿", "流畅",
      "调色板", "终端配色", "滚动缓冲", "回滚", "scrollback", "底色", "预览",
      "外部终端", "终端应用", "iTerm", "Ghostty", "PowerShell", "cmd",
      "自定义运行时", "运行时", "命令",
      "terminal", "font", "runtime",
    ],
  },
  {
    id: "startup",
    label: "通用",
    aliases: [
      "启动", "启动行为", "开机自启", "默认页面", "启动时进入", "导航形态", "侧栏", "导航",
      "顶部岛", "灵动岛", "岛", "自动收起", "通知", "系统通知", "播报",
      "general", "startup", "launch", "nav", "notification",
    ],
  },
  {
    id: "hotkeys",
    label: "快捷键",
    aliases: [
      "快捷键", "热键", "键盘", "按键", "绑定", "组合键", "冲突",
      "shortcut", "hotkey", "keybinding",
    ],
  },
  {
    id: "stats",
    label: "用量",
    aliases: [
      "统计", "用量", "花费", "成本", "额度", "余额", "汇率", "货币", "内部活动",
      "图表", "价目", "定价", "价格", "没有价格", "算不出价",
      "stats", "usage", "cost", "quota",
    ],
  },
  {
    id: "integration",
    label: "AI 与 Agent",
    aliases: [
      "集成", "AI", "AI 配置", "AI 专用", "模型", "按功能",
      "自动命名", "起名", "命名", "会话标题", "改标题", "标题",
      "翻译", "提交信息", "摘要",
      "想法期", "只读", "保护", "hooks", "注意力", "精确注意力",
      "integration", "agent",
    ],
  },
  {
    id: "network",
    label: "网络",
    aliases: [
      "网络", "代理", "出网代理", "proxy", "HTTP 代理", "不走代理", "白名单",
      "镜像", "brew", "Homebrew", "国内镜像",
      "学校图书馆", "图书馆", "浏览器", "登录", "会话", "扩展", "抓取",
      "network", "library",
    ],
  },
  {
    id: "update",
    label: "更新",
    aliases: ["更新", "升级", "版本", "检查更新", "update", "upgrade", "version"],
  },
  {
    id: "diag",
    label: "诊断",
    aliases: [
      "诊断", "日志", "导出日志", "排查", "报错", "依赖", "体检", "自检",
      "Git", "Node.js", "配置快照", "生效配置", "诊断包", "反馈",
      "diagnostics", "log", "debug",
    ],
  },
  {
    id: "storage",
    label: "数据与存储",
    aliases: [
      "数据", "存储", "目录", "项目目录", "位置", "路径", "导出", "备份",
      "清理", "缓存", "打开文件夹", "定位", "卸载", "删除", "回收站", "快照", "工作树", "工作副本", "占用", "磁盘", "C盘", "换盘", "存储位置", "自定义位置", "挪位置", "迁移",
      "内部对话", "内部 AI", "后台对话", "清理对话", "保留天数", "自动清理",
      "storage", "data", "folder", "path",
    ],
  },
  {
    id: "about",
    label: "关于",
    aliases: [
      "关于", "版本", "主页", "项目主页", "开源", "许可", "许可证", "开源许可",
      "第三方", "组件", "版权", "致谢", "隐私", "商标", "反馈", "问题反馈",
      "数据来源", "邮箱直发", "授权码", "SMTP", "反馈邮箱", "issue", "licenses",
      "about", "标星", "star",
    ],
  },
];

/** 查询归一：小写 + 去首尾空白。中文不分词，直接 substring。 */
function norm(s: string): string {
  return s.trim().toLocaleLowerCase();
}

/** 一档的全部可搜文字（档名 + 别名）。 */
function entryText(entry: SettingsSearchEntry): string {
  return norm(`${entry.label} ${entry.aliases.join(" ")}`);
}

/**
 * 复合词：用户会把两个词连着打成一个查询（「依赖体检」「字体大小」），中间没有空格，
 * 而这个组合本身不在任何一条别名里——两条别名各管一半。拆成两半，两半都命中同档
 * 才算命中。只在长度够拆时才试（每半至少 2 字），短查询拆了没意义还会误伤。
 */
function matchesCompound(hay: string, q: string): boolean {
  if (q.length < 4) return false;
  for (let i = 2; i <= q.length - 2; i++) {
    if (hay.includes(q.slice(0, i)) && hay.includes(q.slice(i))) return true;
  }
  return false;
}

/**
 * 按查询过滤档位。空查询返回全部（调用方据此决定是否显示「无结果」）。
 *
 * 分档排序，从强到弱：
 *   1. 档名命中——用户打的就是档名，必须在最前；
 *   2. 别名**全等**——「导出」是「数据与存储」的一条别名，虽然它同时是诊断档
 *      「导出日志」的前缀，全等比前缀更贴近用户意图；
 *   3. 别名包含；
 *   4. 复合词（见 matchesCompound）。
 */
export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = norm(query);
  if (!q) return [...SETTINGS_SEARCH_INDEX];
  const tiers: SettingsSearchEntry[][] = [[], [], [], []];
  for (const entry of SETTINGS_SEARCH_INDEX) {
    const label = norm(entry.label);
    if (label.includes(q)) {
      tiers[0].push(entry);
      continue;
    }
    const aliases = entry.aliases.map(norm);
    if (aliases.some((a) => a === q)) tiers[1].push(entry);
    else if (aliases.some((a) => a.includes(q))) tiers[2].push(entry);
    else if (matchesCompound(entryText(entry), q)) tiers[3].push(entry);
  }
  return tiers.flat();
}
