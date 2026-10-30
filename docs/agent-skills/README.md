# 给 Agent 用的维护技能

这里的技能是**维护 Mesa 仓库本身**用的，不随应用分发给用户（用户用的内置技能在 `src-tauri/resources/skills/`，别放混）。
每个技能一个文件夹，里面一份 `SKILL.md`（开头有 name / description），哪家 Agent 都读得懂。

| 技能 | 管什么 |
|---|---|
| `mesa-cli-canary` | 让 Mesa 跟上九家 CLI：金丝雀日常维护（含「设为全局」写进去的配置外部还认不认），分清环境故障 / Mesa 自身问题 / CLI 变了，适配、更新基线与抓屏语料库；发版前逐家复核官方配置文档；改连接写法时按九条规则核对并用真 CLI 验证；判断哪家可以摘「测试版」 |

## 交给 Agent 的三种方式

**一、不装，直接说（任何 Agent 都行）**：在仓库根目录开一个对话，发：

```
按 docs/agent-skills/mesa-cli-canary/SKILL.md 做今天的金丝雀维护，最后用中文报告。不要推送。
```

**二、装成技能（以后说「做金丝雀维护」就行）**

- Mesa 里：技能页 → ZIP 导入（先打包：`cd docs/agent-skills && zip -r ~/Downloads/mesa-cli-canary.zip mesa-cli-canary`）→ 点这个技能 → **一键应用**，分发给本机装了的各家。
  改了仓库里的 SKILL.md 之后要重新导入（Cursor、Grok 是复制件，另点 **同步副本**）。
- 只给 Claude Code：做个链接，仓库里改了马上生效：

```bash
ln -s "$PWD/docs/agent-skills/mesa-cli-canary" ~/.claude/skills/mesa-cli-canary
```

**三、定时**：在 Claude 桌面版或 Mesa 的定时任务里，每天 10:00（金丝雀北京时间 9:17 开跑，九家约半小时）用方式一那句话开一个对话。
定时跑的时候没人看着，它只会做到「改好、提交在本地、写报告」，不会推送，`--accept` 也只接受本机平台的。
