# 老项目样本（project_upgrade.rs 的升级测试读这里）

每个目录是某一代 Mesa 建出来的项目「长什么样」的最小样本，目录名 `layout-<N>-<说明>`，N 是它停在的结构版本。
改项目结构（加 `.gitignore` 规则、挪台账、改档案卡字段）时，在 `project_upgrade.rs` 的 `UPGRADES` 末尾加一级，
`CURRENT_LAYOUT` 加一，并把升级前那一代的样本放进来。

样本里的点文件去掉了点（`gitignore`、`ccode/`），免得被本仓库的 git 当成自己的规则；测试复制出去后改回来。

- `layout-0-her-2026-11`：HER 综述项目 2026-11 时的 `.gitignore`（缺 `.ccode/rework/`、`step-rounds.jsonl`、`versions/`、文献库导入文件等）
- `layout-0-no-id-2026-10`：更早的档案卡，没有项目 id，`.gitignore` 里还没有任何台账规则
